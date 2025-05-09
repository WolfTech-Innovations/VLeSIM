const dgram = require('dgram');
const http = require('http');
const net = require('net');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { CONFIG } = require ('./Server')

// IP Assignment Pool
class IPAddressPool {
  constructor(baseSubnet = '10.8.0') {
    this.baseSubnet = baseSubnet;
    this.assigned = new Map();
    this.available = Array.from({ length: 250 }, (_, i) => i + 2); // Range 2-251
  }

  assign(identifier) {
    if (this.assigned.has(identifier)) {
      return this.assigned.get(identifier);
    }

    if (this.available.length === 0) {
      throw new Error('IP address pool exhausted');
    }

    const lastOctet = this.available.shift();
    const ipAddress = `${this.baseSubnet}.${lastOctet}`;
    this.assigned.set(identifier, ipAddress);
    return ipAddress;
  }

  release(identifier) {
    if (!this.assigned.has(identifier)) return false;
    
    const ip = this.assigned.get(identifier);
    const lastOctet = parseInt(ip.split('.')[3]);
    this.available.push(lastOctet);
    this.available.sort((a, b) => a - b);
    this.assigned.delete(identifier);
    return true;
  }

  getAssigned(identifier) {
    return this.assigned.get(identifier) || null;
  }
}

// Data packet handler
class DataPacketHandler {
  constructor() {
    this.sessions = new Map();
  }
  
  createSession(imsi, ipAddress) {
    const sessionId = crypto.randomBytes(8).toString('hex');
    this.sessions.set(sessionId, {
      imsi,
      ipAddress,
      created: Date.now(),
      lastActive: Date.now(),
      bytesUp: 0,
      bytesDown: 0
    });
    return sessionId;
  }
  
  updateSession(sessionId, bytesUp = 0, bytesDown = 0) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    session.lastActive = Date.now();
    session.bytesUp += bytesUp;
    session.bytesDown += bytesDown;
    return session;
  }
  
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }
  
  getSessionByImsi(imsi) {
    for (const [id, session] of this.sessions.entries()) {
      if (session.imsi === imsi) return { id, ...session };
    }
    return null;
  }
  
  closeSession(sessionId) {
    return this.sessions.delete(sessionId);
  }
  
  encapsulatePacket(payload, metadata = {}) {
    const header = Buffer.from(JSON.stringify(metadata));
    const headerLength = Buffer.alloc(4);
    headerLength.writeUInt32BE(header.length, 0);
    
    return Buffer.concat([headerLength, header, payload]);
  }
  
  decapsulatePacket(packet) {
    const headerLength = packet.readUInt32BE(0);
    const header = JSON.parse(packet.slice(4, 4 + headerLength).toString());
    const payload = packet.slice(4 + headerLength);
    
    return { header, payload };
  }
}

// Mobile Data Bridge Core
class MobileDataBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: 'CONFIG.SIP_SERVER_PORT + 4',
      ip: '0.0.0.0',
      apn: 'internet' || 'internet',
      dataDir: options.dataDir || './data/mobile',
      ...options
    };
    
    this.ipPool = new IPAddressPool(options.subnet || '10.8.0');
    this.packetHandler = new DataPacketHandler();
    this.clients = new Map();
    this.profiles = new Map();
    this.provisioningServer = http.createServer();
    
    this.dataPath = path.join(process.cwd(), this.options.dataDir);
    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath, { recursive: true });
    }
    
    this.setupServers();
    this.loadProfiles();
  }
  
  setupServers() {
    this.controlServer = net.createServer((socket) => {
      let clientId = null;
      
      socket.on('data', (data) => {
        try {
          const message = JSON.parse(data.toString());
          clientId = message.imsi || clientId;
          
          switch (message.type) {
            case 'connect':
              this.handleClientConnect(message, socket);
              break;
            case 'disconnect':
              this.handleClientDisconnect(message);
              break;
            case 'keepalive':
              this.handleKeepAlive(message);
              break;
          }
        } catch (err) {
          socket.end(JSON.stringify({ error: 'Invalid message format' }));
        }
      });
      
      socket.on('error', (err) => {
        this.emit('error', 'client', err);
      });
      
      socket.on('close', () => {
        if (clientId) {
          this.handleClientDisconnect({ imsi: clientId });
        }
      });
    });
    
    this.controlServer.on('error', (err) => {
      this.emit('error', 'control', err);
    });
    
    this.controlServer.listen(this.options.port + 1, this.options.ip);
    
    // HTTP Provisioning server
    this.provisioningServer.on('request', (req, res) => {
      const parsedUrl = url.parse(req.url, true);
      
      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        return res.end();
      }
      
      // Set CORS headers for all responses
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      switch (parsedUrl.pathname) {
        case '/provision':
          this.handleProvisionRequest(req, res);
          break;
        case '/config':
          this.handleConfigRequest(req, res, parsedUrl.query);
          break;
        default:
          res.writeHead(404);
          res.end('Not Found');
      }
    });
    
    this.provisioningServer.on('error', (err) => {
      this.emit('error', 'provisioning', err);
    });
    
    this.provisioningServer.listen(this.options.port + 2, this.options.ip);
  }
  
  loadProfiles() {
    try {
      const files = fs.readdirSync(this.dataPath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const profile = JSON.parse(fs.readFileSync(path.join(this.dataPath, file), 'utf8'));
          this.profiles.set(profile.imsi, profile);
        }
      }
      this.emit('profiles-loaded', this.profiles.size);
    } catch (err) {
      this.emit('error', 'profiles', err);
    }
  }
  
  saveProfile(profile) {
    try {
      fs.writeFileSync(
        path.join(this.dataPath, `${profile.imsi}.json`),
        JSON.stringify(profile, null, 2)
      );
      return true;
    } catch (err) {
      this.emit('error', 'profile-save', err);
      return false;
    }
  }
  
  handleDataPacket(packet, sender) {
    try {
      const { header, payload } = this.packetHandler.decapsulatePacket(packet);
      const session = this.packetHandler.getSession(header.sessionId);
      
      if (!session) {
        return this.emit('error', 'data', new Error('Invalid session'));
      }
      
      this.packetHandler.updateSession(header.sessionId, payload.length, 0);
      
      // Route the packet (simplified here - in a real implementation you'd have full IP routing)
      if (header.direction === 'up') {
        // Traffic from device to internet
        this.emit('data-up', {
          imsi: session.imsi,
          payload,
          size: payload.length
        });
      } else {
        // Traffic from internet to device
        const client = this.clients.get(session.imsi);
        if (client && client.address) {
          const encapsulated = this.packetHandler.encapsulatePacket(payload, {
            sessionId: header.sessionId,
            direction: 'down'
          });
          
          this.dataServer.send(encapsulated, client.port, client.address);
          this.packetHandler.updateSession(header.sessionId, 0, payload.length);
        }
      }
    } catch (err) {
      this.emit('error', 'data-packet', err);
    }
  }
  
  handleClientConnect(message, socket) {
    try {
      const { imsi } = message;
      const profile = this.profiles.get(imsi);
      
      if (!profile) {
        return socket.end(JSON.stringify({ error: 'Unknown IMSI' }));
      }
      
      // Assign IP and create data session
      const ipAddress = this.ipPool.assign(imsi);
      const sessionId = this.packetHandler.createSession(imsi, ipAddress);
      
      this.clients.set(imsi, {
        address: socket.remoteAddress,
        port: message.dataPort || this.options.port,
        socket,
        sessionId,
        connected: Date.now()
      });
      
      socket.write(JSON.stringify({
        status: 'connected',
        sessionId,
        ipAddress,
        dns: ['8.8.8.8', '1.1.1.1'],
        mtu: 1400,
        apn: this.options.apn
      }));
      
      this.emit('client-connected', { imsi, ipAddress, sessionId });
    } catch (err) {
      socket.end(JSON.stringify({ error: err.message }));
      this.emit('error', 'connect', err);
    }
  }
  
  handleClientDisconnect(message) {
    const { imsi } = message;
    const client = this.clients.get(imsi);
    
    if (client) {
      if (client.socket && !client.socket.destroyed) {
        client.socket.end(JSON.stringify({ status: 'disconnected' }));
      }
      
      if (client.sessionId) {
        this.packetHandler.closeSession(client.sessionId);
      }
      
      this.ipPool.release(imsi);
      this.clients.delete(imsi);
      this.emit('client-disconnected', { imsi });
    }
  }
  
  handleKeepAlive(message) {
    const { imsi, sessionId } = message;
    const client = this.clients.get(imsi);
    
    if (client && client.sessionId === sessionId) {
      this.packetHandler.updateSession(sessionId);
      if (client.socket && !client.socket.destroyed) {
        client.socket.write(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
      }
    }
  }
  
  async handleProvisionRequest(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end('Method Not Allowed');
    }
    
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        
        if (!data.iccid || !data.imsi || !data.msisdn) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Missing required fields' }));
        }
        
        const profile = {
          imsi: data.imsi,
          iccid: data.iccid,
          msisdn: data.msisdn,
          apn: this.options.apn,
          created: Date.now(),
          status: 'active',
          dataEnabled: true
        };
        
        this.profiles.set(data.imsi, profile);
        this.saveProfile(profile);
        
        const config = this.generateDeviceConfig(profile);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'provisioned',
          profile,
          config
        }));
        
        this.emit('profile-provisioned', profile);
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid request format' }));
      }
    });
  }
  
  handleConfigRequest(req, res, query) {
    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end('Method Not Allowed');
    }
    
    const { imsi } = query;
    if (!imsi) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'Missing IMSI parameter' }));
    }
    
    const profile = this.profiles.get(imsi);
    if (!profile) {
      res.writeHead(404);
      return res.end(JSON.stringify({ error: 'Profile not found' }));
    }
    
    const config = this.generateDeviceConfig(profile);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'success',
      config
    }));
  }
  
  generateDeviceConfig(profile) {
    return {
      apn: this.options.apn,
      servers: {
        data: `${this.options.ip}:${this.options.port}`,
        control: `${this.options.ip}:${this.options.port + 1}`,
        provisioning: `http://${this.options.ip}:${this.options.port + 2}`
      },
      authentication: {
        type: 'none',
        imsi: profile.imsi
      }
    };
  }
  
  sendDataToClient(imsi, data) {
    const client = this.clients.get(imsi);
    if (!client || !client.sessionId) return false;
    
    const session = this.packetHandler.getSession(client.sessionId);
    if (!session) return false;
    
    const packet = this.packetHandler.encapsulatePacket(data, {
      sessionId: client.sessionId,
      direction: 'down'
    });
    
    this.dataServer.send(packet, client.port, client.address);
    this.packetHandler.updateSession(client.sessionId, 0, data.length);
    return true;
  }
  
  close() {
    // Close all clients
    for (const client of this.clients.values()) {
      if (client.socket && !client.socket.destroyed) {
        client.socket.end(JSON.stringify({ status: 'server_shutdown' }));
      }
    }
    
    // Close servers
    this.dataServer.close();
    this.provisioningServer.close();
    this.controlServer.close();
    
    this.emit('closed');
  }
}

class IntegratedMobileDataProvider {
  constructor(voipProvider, options = {}) {
    this.voipProvider = voipProvider;
    this.bridge = new MobileDataBridge(options);
    
    this.setupEventHandlers();
  }
  
  setupEventHandlers() {
    // When a new eSIM is provisioned via VoIP, also setup data profile
    this.voipProvider.sipServer.on('provision-request', (message, transport) => {
      try {
        // This event handler runs after the VoIP provisioner created the profile
        const phoneNumber = message.headers.from.split(':')[1].split('@')[0];
        const profile = this.voipProvider.getProfileByPhoneNumber(phoneNumber);
        
        if (profile) {
          // Register the profile with the data bridge
          this.provisionDataProfile(profile);
        }
      } catch (err) {
        console.error('Error setting up data profile:', err);
      }
    });
    
    // Sync profiles from VoIP provider on startup
    setTimeout(() => {
      this.syncProfiles();
    }, 1000);
  }
  
  syncProfiles() {
    // For each registered phone number, ensure we have a data profile
    this.voipProvider.phoneToProfile.forEach((iccid, phoneNumber) => {
      const profile = this.voipProvider.esimProvisioner.getProfile(iccid);
      if (profile) {
        this.provisionDataProfile(profile);
      }
    });
  }
  
  provisionDataProfile(profile) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: this.bridge.options.port + 2,
        path: '/provision',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result);
          } catch (err) {
            reject(err);
          }
        });
      });
      
      req.on('error', (err) => {
        reject(err);
      });
      
      req.write(JSON.stringify({
        iccid: profile.iccid,
        imsi: profile.imsi,
        msisdn: profile.msisdn
      }));
      
      req.end();
    });
  }
  
  close() {
    this.bridge.close();
  }
}

module.exports = {
  MobileDataBridge,
  IntegratedMobileDataProvider
};