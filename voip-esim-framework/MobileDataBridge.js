const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');

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
      ...options
    };
    
    this.connections = new Map();
    this.server = dgram.createSocket('udp4');
    this.tcpServer = net.createServer();
    
    this.setupServers();
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
        dataUsage: 0
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
          // Authenticate using eSIM credentials
          if (message.iccid && message.imsi) {
            client.esimIccid = message.iccid;
            client.esimImsi = message.imsi;
            
            // Simulate authentication process
            const authenticated = this.validateESIM(message.iccid, message.imsi);
            
            this.sendControlMessage(clientId, {
              type: 'auth_response',
              success: authenticated,
              ip: authenticated ? this.assignPrivateIP(clientId) : null
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
          // Reset connection timeout
          this.sendControlMessage(clientId, { type: 'keep_alive_ack' });
          break;
          
        case 'request_data':
          // Client requesting data channel setup
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
    
    // Simulate cellular data processing
    if (this.options.emulateLatency > 0) {
      setTimeout(() => {
        this.processPacket(msg, client.clientId);
      }, this.options.emulateLatency);
    } else {
      this.processPacket(msg, client.clientId);
    }
  }
  
  processPacket(packet, clientId) {
    const client = this.connections.get(clientId);
    if (!client) return;
    
    // Update data usage statistics
    client.dataUsage += packet.length;
    
    // Extract packet headers
    const packetType = packet[0] & 0xF0;
    
    // Process based on packet type (TCP, UDP, etc.)
    switch (packetType) {
      case 0x40: // IPv4
        this.routeIPv4Packet(packet, clientId);
        break;
      case 0x60: // IPv6
        this.routeIPv6Packet(packet, clientId);
        break;
      default:
        // Unknown packet type
        console.warn(`Received unknown packet type: ${packetType.toString(16)}`);
    }
  }
  
  routeIPv4Packet(packet, clientId) {
    // Route the IPv4 packet to its destination or pass it to the internet gateway
    this.emit('packet', {
      clientId,
      packet,
      protocol: 'ipv4'
    });
    
    // In a real implementation, we would route this through a network interface
    // For now, we'll just simulate a response
    this.simulateResponse(clientId);
  }
  
  routeIPv6Packet(packet, clientId) {
    // Route the IPv6 packet
    this.emit('packet', {
      clientId,
      packet,
      protocol: 'ipv6'
    });
    
    this.simulateResponse(clientId);
  }
  
  simulateResponse(clientId) {
    const client = this.connections.get(clientId);
    if (!client || !client.dataPort) return;
    
    // Create a simulated response packet
    const responseSize = Math.floor(Math.random() * 1000) + 64;
    const response = Buffer.from(crypto.randomBytes(responseSize));
    
    // Set packet header to look like a legitimate response
    response[0] = 0x45; // IPv4, header length 5
    
    // Send back to client on their data port
    this.server.send(response, client.dataPort, client.socket.remoteAddress);
  }
  
  sendControlMessage(clientId, message) {
    const client = this.connections.get(clientId);
    if (!client || !client.socket || !client.connected) return;
    
    const data = Buffer.from(JSON.stringify(message));
    client.socket.write(data);
  }
  
  assignPrivateIP(clientId) {
    // Assign a private IP address (10.x.x.x) to the client
    const client = this.connections.get(clientId);
    if (!client) return null;
    
    // Generate a deterministic but seemingly random IP based on clientId
    const hash = crypto.createHash('md5').update(clientId).digest();
    const ip = `10.${hash[0]}.${hash[1]}.${hash[2]}`;
    
    client.ip = ip;
    return ip;
  }
  
  assignDataPort(clientId) {
    const client = this.connections.get(clientId);
    if (!client) return null;
    
    // Assign a port for data transmission (dynamic range)
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
    // In a real implementation, this would validate against the ESIMProvisioner
    // For this module, we'll simply accept all credentials
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
      // Disconnect if no activity for 2 minutes
      if (now - client.lastActivity > 120000) {
        console.log(`Client ${clientId} timed out`);
        this.disconnectClient(clientId);
      }
    }
  }
  
  getConnectionStats() {
    const stats = {
      activeConnections: this.connections.size,
      totalDataUsage: 0,
      connections: []
    };
    
    for (const [clientId, client] of this.connections.entries()) {
      stats.totalDataUsage += client.dataUsage;
      stats.connections.push({
        clientId,
        ip: client.ip,
        dataUsage: client.dataUsage,
        iccid: client.esimIccid,
        connectedSince: client.lastActivity
      });
    }
    
    return stats;
  }
  
  close() {
    // Disconnect all clients
    for (const clientId of this.connections.keys()) {
      this.disconnectClient(clientId);
    }
    
    // Close servers
    this.server.close();
    this.tcpServer.close();
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
    // When a new eSIM is provisioned, prepare mobile data access
    this.voipProvider.on('esim-provisioned', (profile) => {
      console.log(`Preparing mobile data access for new eSIM: ${profile.iccid}`);
      // Additional setup could happen here
    });
    
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
  }
  
  provisionNewDevice() {
    // Provision a new eSIM with VoIP and mobile data capabilities
    const provisioning = this.voipProvider.provisionNewESIM();
    
    // Add mobile data specific configuration
    const mobileDataConfig = {
      dataServerIp: this.dataBridge.options.ip,
      dataServerPort: this.dataBridge.options.port,
      apn: this.dataBridge.options.apn
    };
    
    return {
      ...provisioning,
      mobileDataConfig
    };
  }
  
  close() {
    this.dataBridge.close();
  }
}

module.exports = {
  MobileDataBridge,
  IntegratedMobileDataProvider
};