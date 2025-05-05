const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');
const { exec } = require('child_process');
const fs = require('fs');

class MobileDataBridge extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      ip: options.ip || '0.0.0.0',
      port: options.port || 8080,
      apn: options.apn || 'private.apn',
      mtu: options.mtu || 1500,
      dataRate: options.dataRate || 256, // kbps
      emulateLatency: options.emulateLatency || 100, // ms
      tunInterface: options.tunInterface || '/dev/net/tun', // Tun interface
      ...options
    };

    this.connections = new Map();
    this.server = dgram.createSocket('udp4');
    this.tcpServer = net.createServer();

    this.setupTunInterface();
    this.setupServers();
  }

  setupTunInterface() {
    // Set up the TUN interface to route packets
    exec(`ip tuntap add dev tun0 mode tun`, (err, stdout, stderr) => {
      if (err) {
        console.error('Error creating TUN interface:', stderr);
        return;
      }
      console.log('TUN interface created: tun0');
      exec(`ifconfig tun0 10.0.0.1/24 up`, (err) => {
        if (err) {
          console.error('Error configuring TUN interface:', err);
        } else {
          console.log('TUN interface configured with IP: 10.0.0.1/24');
        }
      });
    });
  }

  setupServers() {
    // UDP server for data packets
    this.server.on('error', (err) => {
      console.error(`UDP data server error: ${err}`);
      this.server.close();
    });

    this.server.on('message', (msg, rinfo) => {
      this.handleDataPacket(msg, rinfo);
    });

    this.server.on('listening', () => {
      const address = this.server.address();
      console.log(`Mobile data bridge listening on ${address.address}:${address.port}`);
    });

    this.server.bind(this.options.port);

    // TCP server for control channel
    this.tcpServer.on('connection', (socket) => {
      const clientId = `${socket.remoteAddress}:${socket.remotePort}`;

      this.connections.set(clientId, {
        socket,
        connected: true,
        lastActivity: Date.now(),
        esimIccid: null,
        dataUsage: 0,
        dataPort: null
      });

      socket.on('data', (data) => {
        this.handleControlMessage(data, clientId);
      });

      socket.on('error', (err) => {
        console.error(`TCP socket error for ${clientId}: ${err}`);
        this.disconnectClient(clientId);
      });

      socket.on('close', () => {
        this.disconnectClient(clientId);
      });

      // Send welcome message with APN info
      this.sendControlMessage(clientId, {
        type: 'welcome',
        apn: this.options.apn,
        mtu: this.options.mtu,
        dataRate: this.options.dataRate
      });
    });

    this.tcpServer.listen(this.options.port + 1, this.options.ip, () => {
      console.log(`Mobile data control channel listening on ${this.options.ip}:${this.options.port + 1}`);
    });

    // Heartbeat to check connection status
    setInterval(() => this.checkConnections(), 30000);
  }

  handleControlMessage(data, clientId) {
    try {
      const message = JSON.parse(data.toString());
      const client = this.connections.get(clientId);

      if (!client) return;
      client.lastActivity = Date.now();

      switch (message.type) {
        case 'auth':
          if (message.iccid && message.imsi) {
            client.esimIccid = message.iccid;
            client.esimImsi = message.imsi;

            const authenticated = this.validateESIM(message.iccid, message.imsi);

            this.sendControlMessage(clientId, {
              type: 'auth_response',
              success: authenticated
            });

            if (authenticated) {
              this.emit('client-connected', {
                clientId,
                iccid: message.iccid,
                imsi: message.imsi
              });
            }
          }
          break;

        case 'keep_alive':
          this.sendControlMessage(clientId, { type: 'keep_alive_ack' });
          break;

        case 'request_data':
          const dataPort = this.assignDataPort(clientId);
          this.sendControlMessage(clientId, {
            type: 'data_channel',
            port: dataPort
          });
          break;
      }
    } catch (err) {
      console.error(`Error processing control message from ${clientId}: ${err}`);
    }
  }

  handleDataPacket(msg, rinfo) {
    const clientId = `${rinfo.address}:${rinfo.port}`;
    const client = this.getClientByDataPort(rinfo.port);

    if (!client) return;

    // Real packet processing
    this.routePacket(msg, clientId);
  }

  routePacket(packet, clientId) {
    const client = this.connections.get(clientId);
    if (!client) return;

    client.dataUsage += packet.length;
    const packetType = packet[0] & 0xF0;

    // Process based on packet type
    switch (packetType) {
      case 0x40: // IPv4
        this.routeIPv4Packet(packet, clientId);
        break;
      case 0x60: // IPv6
        this.routeIPv6Packet(packet, clientId);
        break;
      default:
        console.warn(`Received unknown packet type: ${packetType.toString(16)}`);
    }
  }

  routeIPv4Packet(packet, clientId) {
    const client = this.connections.get(clientId);
    if (client && client.dataPort) {
      console.log(`Routing IPv4 packet for ${clientId} to TUN interface`);

      // Forward packet to TUN interface (real routing logic)
      fs.writeFileSync('/dev/net/tun', packet);  // Send to tun interface
    }
  }

  routeIPv6Packet(packet, clientId) {
    const client = this.connections.get(clientId);
    if (client && client.dataPort) {
      console.log(`Routing IPv6 packet for ${clientId} to TUN interface`);

      // Forward packet to TUN interface (real routing logic)
      fs.writeFileSync('/dev/net/tun', packet);  // Send to tun interface
    }
  }

  sendControlMessage(clientId, message) {
    const client = this.connections.get(clientId);
    if (!client || !client.socket || !client.connected) return;

    const data = Buffer.from(JSON.stringify(message));
    client.socket.write(data);
  }

  assignDataPort(clientId) {
    const client = this.connections.get(clientId);
    if (!client) return null;

    const dataPort = 49152 + Math.floor(Math.random() * 16383);
    client.dataPort = dataPort;

    return dataPort;
  }

  getClientByDataPort(port) {
    for (const [clientId, client] of this.connections.entries()) {
      if (client.dataPort === port) {
        return { ...client, clientId };
      }
    }
    return null;
  }

  validateESIM(iccid, imsi) {
    // Simple mock authentication
    return true;
  }

  disconnectClient(clientId) {
    const client = this.connections.get(clientId);
    if (!client) return;

    client.connected = false;
    if (client.socket) {
      try {
        client.socket.end();
      } catch (e) {
        // Socket may already be closed
      }
    }

    this.connections.delete(clientId);
    this.emit('client-disconnected', { clientId });

    console.log(`Client disconnected: ${clientId}`);
  }

  checkConnections() {
    const now = Date.now();
    for (const [clientId, client] of this.connections.entries()) {
      if (now - client.lastActivity > 120000) {
        console.log(`Client ${clientId} timed out`);
        this.disconnectClient(clientId);
      }
    }
  }

  close() {
    for (const clientId of this.connections.keys()) {
      this.disconnectClient(clientId);
    }

    this.server.close();
    this.tcpServer.close();
    console.log('Mobile data bridge closed');
  }
}
// Integration with existing VoIP eSIM Provider
class IntegratedMobileDataProvider {
  constructor(voipProvider, options = {}) {
    this.voipProvider = voipProvider;
    this.dataBridge = new MobileDataBridge(options);
    
    // Connect the systems
    this.setupIntegration();
  }
  
  setupIntegration() {
    // Since VoIPESIMProvider doesn't extend EventEmitter, we'll use direct
    // verification instead of events
    
    // For new provisioning, we'll override the provisionNewESIM method in our wrapper
    
    // When a client connects via mobile data, verify with eSIM system
    this.dataBridge.on('client-connected', ({ clientId, iccid }) => {
      const profile = this.voipProvider.esimProvisioner.getProfile(iccid);
      if (profile) {
        console.log(`Mobile data connection established for ${profile.msisdn}`);
      } else {
        console.warn(`Unknown eSIM connected: ${iccid}`);
        this.dataBridge.disconnectClient(clientId);
      }
    });
}}
  
module.exports = {
  MobileDataBridge,
  IntegratedMobileDataProvider
};