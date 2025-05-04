// Global Configuration
const CONFIG = {
    SIP_SERVER_URL: '0.0.0.0', // SIP server domain
    SIP_SERVER_PORT: 5053,         // SIP port
    SIP_SERVER_PROTOCOL: 'udp',    // Protocol (udp/tcp)
    PHONE_NUMBER_PREFIX: '935',   // Prefix for generated phone numbers
    DATA_DIR: './data'             // Directory for storing data
  };
  
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const dgram = require('dgram');
  const net = require('net');
  const { EventEmitter } = require('events');
  
  class ESIMProvisioner {
    constructor() {
      this.profiles = new Map();
      this.dataPath = path.join(__dirname, CONFIG.DATA_DIR, 'esims');
      
      if (!fs.existsSync(this.dataPath)) {
        fs.mkdirSync(this.dataPath, { recursive: true });
      }
      
      this.loadProfiles();
    }
    
    loadProfiles() {
      try {
        const files = fs.readdirSync(this.dataPath);
        files.forEach(file => {
          if (file.endsWith('.json')) {
            const profile = JSON.parse(fs.readFileSync(path.join(this.dataPath, file), 'utf8'));
            this.profiles.set(profile.iccid, profile);
          }
        });
      } catch (err) {
        console.error('Error loading eSIM profiles:', err);
      }
    }
    
    generateIccid() {
      const prefix = '8988';
      const mii = '01'; // Issuer identifier
      const random = Math.floor(Math.random() * 10000000000).toString().padStart(10, '0');
      const baseIccid = prefix + mii + random;
      
      let sum = 0;
      for (let i = 0; i < baseIccid.length; i++) {
        let digit = parseInt(baseIccid[i]);
        if (i % 2 === 0) {
          digit *= 2;
          if (digit > 9) digit -= 9;
        }
        sum += digit;
      }
      
      const checkDigit = (10 - (sum % 10)) % 10;
      return baseIccid + checkDigit;
    }
    
    generateImsi() {
      const mcc = '310'; // US
      const mnc = '260'; // Test network
      const msin = Math.floor(Math.random() * 10000000000).toString().padStart(10, '0');
      return mcc + mnc + msin;
    }
    
    generateKi() {
      return crypto.randomBytes(16).toString('hex');
    }
    
    generateOpc() {
      return crypto.randomBytes(16).toString('hex');
    }
    
    createProfile(msisdn) {
      const iccid = this.generateIccid();
      const imsi = this.generateImsi();
      const ki = this.generateKi();
      const opc = this.generateOpc();
      
      const profile = {
        iccid,
        imsi,
        msisdn,
        ki,
        opc,
        status: 'active',
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      };
      
      this.profiles.set(iccid, profile);
      fs.writeFileSync(path.join(this.dataPath, `${iccid}.json`), JSON.stringify(profile, null, 2));
      
      return profile;
    }
    
    getProfile(iccid) {
      return this.profiles.get(iccid);
    }
    
    updateProfile(iccid, updates) {
      const profile = this.profiles.get(iccid);
      if (!profile) return null;
      
      const updatedProfile = { ...profile, ...updates, lastUpdated: new Date().toISOString() };
      this.profiles.set(iccid, updatedProfile);
      fs.writeFileSync(path.join(this.dataPath, `${iccid}.json`), JSON.stringify(updatedProfile, null, 2));
      
      return updatedProfile;
    }
    
    deleteProfile(iccid) {
      if (!this.profiles.has(iccid)) return false;
      
      this.profiles.delete(iccid);
      fs.unlinkSync(path.join(this.dataPath, `${iccid}.json`));
      
      return true;
    }
    
    generateActivationData(iccid) {
      const profile = this.profiles.get(iccid);
      if (!profile) return null;
      
      const activationCode = crypto.randomBytes(8).toString('hex').toUpperCase();
      const smDpPlusAddress = CONFIG.SIP_SERVER_URL;
      
      const activationData = {
        iccid,
        activationCode,
        smDpPlusAddress,
        sipServerUrl: `sip:${profile.msisdn}@${CONFIG.SIP_SERVER_URL}:${CONFIG.SIP_SERVER_PORT};transport=${CONFIG.SIP_SERVER_PROTOCOL}`,
        encodedActivationCode: Buffer.from(JSON.stringify({
          iccid,
          imsi: profile.imsi,
          ki: profile.ki,
          opc: profile.opc,
          msisdn: profile.msisdn,
          sipServerUrl: `sip:${profile.msisdn}@${CONFIG.SIP_SERVER_URL}:${CONFIG.SIP_SERVER_PORT};transport=${CONFIG.SIP_SERVER_PROTOCOL}`
        })).toString('base64')
      };
      
      return activationData;
    }
  }
  
  class SIPMessage {
    static parse(data) {
      const message = {};
      const lines = data.toString().split('\r\n');
      
      const requestLine = lines[0].split(' ');
      if (requestLine[0] === 'SIP/2.0') {
        message.type = 'response';
        message.statusCode = parseInt(requestLine[1]);
        message.reasonPhrase = requestLine[2];
      } else {
        message.type = 'request';
        message.method = requestLine[0];
        message.uri = requestLine[1];
        message.version = requestLine[2];
      }
      
      message.headers = {};
      let i = 1;
      for (; i < lines.length; i++) {
        if (lines[i] === '') break;
        
        const headerParts = lines[i].split(': ');
        const headerName = headerParts[0].toLowerCase();
        const headerValue = headerParts.slice(1).join(': ');
        
        message.headers[headerName] = headerValue;
      }
      
      if (i < lines.length - 1) {
        message.body = lines.slice(i + 1).join('\r\n');
      }
      
      return message;
    }
    
    static create(options) {
      let message = '';
      
      if (options.type === 'request') {
        message += `${options.method} ${options.uri} SIP/2.0\r\n`;
      } else {
        message += `SIP/2.0 ${options.statusCode} ${options.reasonPhrase}\r\n`;
      }
      
      Object.entries(options.headers).forEach(([name, value]) => {
        message += `${name}: ${value}\r\n`;
      });
      
      message += '\r\n';
      
      if (options.body) {
        message += options.body;
      }
      
      return Buffer.from(message);
    }
  }
  
  class SIPServer extends EventEmitter {
    constructor(options = {}) {
      super();
      
      this.options = {
        udpPort: options.udpPort || CONFIG.SIP_SERVER_PORT,
        tcpPort: options.tcpPort || CONFIG.SIP_SERVER_PORT,
        domain: options.domain || CONFIG.SIP_SERVER_URL,
        ...options
      };
      
      this.registrations = new Map();
      this.calls = new Map();
      this.mediaRelays = new Map();
      this.allowOutboundCalls = true;
      
      this.udpServer = dgram.createSocket('udp4');
      this.tcpServer = net.createServer();
      
      this.setupUdpServer();
      this.setupTcpServer();
    }
    
    setupUdpServer() {
      this.udpServer.on('error', (err) => {
        console.error(`UDP server error: ${err}`);
        this.udpServer.close();
      });
      
      this.udpServer.on('message', (msg, rinfo) => {
        try {
          const sipMessage = SIPMessage.parse(msg);
          this.handleSIPMessage(sipMessage, {
            protocol: 'udp',
            address: rinfo.address,
            port: rinfo.port
          });
        } catch (err) {
          console.error('Error handling UDP SIP message:', err);
        }
      });
      
      this.udpServer.on('listening', () => {
        const address = this.udpServer.address();
        console.log(`UDP SIP server listening on ${address.address}:${address.port}`);
      });
      
      this.udpServer.bind(this.options.udpPort);
    }
    
    setupTcpServer() {
      this.tcpServer.on('connection', (socket) => {
        socket.on('data', (data) => {
          try {
            const sipMessage = SIPMessage.parse(data);
            this.handleSIPMessage(sipMessage, {
              protocol: 'tcp',
              socket
            });
          } catch (err) {
            console.error('Error handling TCP SIP message:', err);
          }
        });
        
        socket.on('error', (err) => {
          console.error(`TCP socket error: ${err}`);
          socket.destroy();
        });
      });
      
      this.tcpServer.on('error', (err) => {
        console.error(`TCP server error: ${err}`);
        this.tcpServer.close();
      });
      
      this.tcpServer.listen(this.options.tcpPort, () => {
        console.log(`TCP SIP server listening on port ${this.options.tcpPort}`);
      });
    }
    
    handleSIPMessage(message, transport) {
      this.emit('message', message, transport);
      
      if (message.type === 'request') {
        switch (message.method) {
          case 'REGISTER':
            this.handleRegister(message, transport);
            break;
          case 'INVITE':
            this.handleInvite(message, transport);
            break;
          case 'BYE':
            this.handleBye(message, transport);
            break;
          case 'ACK':
            this.handleAck(message, transport);
            break;
          case 'CANCEL':
            this.handleCancel(message, transport);
            break;
          case 'OPTIONS':
            this.handleOptions(message, transport);
            break;
          default:
            this.sendResponse(message, transport, 405, 'Method Not Allowed');
        }
      }
    }
    
    handleRegister(message, transport) {
      const aor = message.headers.to.split('<')[1].split('>')[0];
      const contact = message.headers.contact ? message.headers.contact.split('<')[1].split('>')[0] : null;
      const expires = message.headers.expires ? parseInt(message.headers.expires) : 3600;
      
      if (expires > 0 && contact) {
        this.registrations.set(aor, {
          contact,
          expires: Date.now() + expires * 1000,
          transport
        });
        
        console.log(`Registered ${aor} at ${contact} (expires in ${expires}s)`);
      } else {
        this.registrations.delete(aor);
        console.log(`Unregistered ${aor}`);
      }
      
      this.sendResponse(message, transport, 200, 'OK', {
        'Contact': message.headers.contact,
        'Expires': expires.toString()
      });
    }
    
    handleInvite(message, transport) {
      const callId = message.headers['call-id'];
      const to = message.headers.to.split('<')[1].split('>')[0];
      const from = message.headers.from.split('<')[1].split('>')[0];
      
      const toRegistration = this.registrations.get(to);
      
      // Special case for provisioning requests
      if (to.includes(`@${CONFIG.SIP_SERVER_URL}`) && to.includes('provision')) {
        this.emit('provision-request', message, transport);
        return;
      }
      
      // Handle external calls
      const isExternalCall = !toRegistration && this.allowOutboundCalls && !to.includes(`@${CONFIG.SIP_SERVER_URL}`);
      if (isExternalCall) {
        return this.handleExternalCall(message, transport, to, from, callId);
      }
      
      if (!toRegistration) {
        return this.sendResponse(message, transport, 404, 'Not Found');
      }
      
      const sdpStart = message.body.indexOf('v=0');
      const sdp = sdpStart >= 0 ? message.body.substring(sdpStart) : '';
      
      const call = {
        id: callId,
        from,
        to,
        fromTransport: transport,
        toTransport: toRegistration.transport,
        fromSDP: sdp,
        state: 'ringing'
      };
      
      this.calls.set(callId, call);
      
      this.sendResponse(message, transport, 100, 'Trying');
      
      const forwardedInvite = SIPMessage.create({
        type: 'request',
        method: 'INVITE',
        uri: to,
        headers: {
          ...message.headers,
          'via': `SIP/2.0/${toRegistration.transport.protocol} ${this.options.domain};branch=${crypto.randomBytes(8).toString('hex')}`,
          'contact': `<sip:${this.options.domain}>`
        },
        body: message.body
      });
      
      this.sendMessage(forwardedInvite, toRegistration.transport);
    }
    
    handleExternalCall(message, transport, to, from, callId) {
      // Extract external domain from the SIP URI
      const toDomain = to.split('@')[1].split(';')[0].split(':')[0];
      const toUsername = to.split(':')[1].split('@')[0];
      
      console.log(`Handling external call to ${toUsername}@${toDomain}`);
      
      // Create a new socket for the external connection
      const externalSocket = dgram.createSocket('udp4');
      
      // Get the SDP from the original message
      const sdpStart = message.body.indexOf('v=0');
      const sdp = sdpStart >= 0 ? message.body.substring(sdpStart) : '';
      
      // Send 100 Trying to the original caller
      this.sendResponse(message, transport, 100, 'Trying');
      
      // Create a new INVITE message for the external server
      const externalInvite = SIPMessage.create({
        type: 'request',
        method: 'INVITE',
        uri: to,
        headers: {
          'via': `SIP/2.0/UDP ${this.options.domain};branch=${crypto.randomBytes(8).toString('hex')}`,
          'from': message.headers.from,
          'to': message.headers.to,
          'call-id': callId,
          'cseq': message.headers.cseq,
          'contact': `<sip:${this.options.domain};transport=UDP>`,
          'max-forwards': '70',
          'content-type': 'application/sdp',
          'content-length': Buffer.byteLength(sdp).toString()
        },
        body: sdp
      });
      
      // Prepare the external transport
      const externalTransport = {
        protocol: 'udp',
        socket: externalSocket,
        address: toDomain,
        port: 5060 // Standard SIP port
      };
      
      // Set up a call object to track the external call
      const call = {
        id: callId,
        from,
        to,
        fromTransport: transport,
        toTransport: externalTransport,
        fromSDP: sdp,
        state: 'trying',
        isExternal: true
      };
      
      this.calls.set(callId, call);
      
      // Set up handler for responses from the external server
      externalSocket.on('message', (data, rinfo) => {
        try {
          const response = SIPMessage.parse(data);
          
          if (response.type === 'response' && response.headers['call-id'] === callId) {
            // Forward the response back to the original caller
            this.sendResponse(message, transport, response.statusCode, response.reasonPhrase, 
              response.headers, response.body);
            
            if (response.statusCode === 200) {
              call.state = 'accepted';
              if (response.body) {
                call.toSDP = response.body;
                // After receiving 200 OK with SDP, we need to set up the media relay
                if (call.fromSDP && call.toSDP) {
                  this.setupMediaRelay(callId, call);
                }
              }
            }
          }
        } catch (err) {
          console.error('Error handling external SIP response:', err);
        }
      });
      
      // Send the INVITE to the external server
      externalSocket.send(externalInvite, 5060, toDomain, (err) => {
        if (err) {
          console.error(`Error sending external INVITE: ${err}`);
          this.sendResponse(message, transport, 500, 'Server Error');
          this.calls.delete(callId);
        }
      });
    }
    
    handleBye(message, transport) {
      const callId = message.headers['call-id'];
      const call = this.calls.get(callId);
      
      if (!call) {
        return this.sendResponse(message, transport, 481, 'Call/Transaction Does Not Exist');
      }
      
      const otherTransport = transport === call.fromTransport ? call.toTransport : call.fromTransport;
      
      const forwardedBye = SIPMessage.create({
        type: 'request',
        method: 'BYE',
        uri: transport === call.fromTransport ? call.to : call.from,
        headers: {
          ...message.headers,
          'via': `SIP/2.0/${otherTransport.protocol} ${this.options.domain};branch=${crypto.randomBytes(8).toString('hex')}`,
          'contact': `<sip:${this.options.domain}>`
        }
      });
      
      this.sendMessage(forwardedBye, otherTransport);
      this.sendResponse(message, transport, 200, 'OK');
      
      this.calls.delete(callId);
      
      if (this.mediaRelays.has(callId)) {
        this.mediaRelays.get(callId).close();
        this.mediaRelays.delete(callId);
      }
    }
    
    handleAck(message, transport) {
      const callId = message.headers['call-id'];
      const call = this.calls.get(callId);
      
      if (!call) return;
      
      const otherTransport = transport === call.fromTransport ? call.toTransport : call.fromTransport;
      
      const forwardedAck = SIPMessage.create({
        type: 'request',
        method: 'ACK',
        uri: transport === call.fromTransport ? call.to : call.from,
        headers: {
          ...message.headers,
          'via': `SIP/2.0/${otherTransport.protocol} ${this.options.domain};branch=${crypto.randomBytes(8).toString('hex')}`,
          'contact': `<sip:${this.options.domain}>`
        },
        body: message.body
      });
      
      this.sendMessage(forwardedAck, otherTransport);
      
      if (call.state === 'accepted' && call.fromSDP && call.toSDP) {
        this.setupMediaRelay(callId, call);
      }
    }
    
    handleCancel(message, transport) {
      const callId = message.headers['call-id'];
      const call = this.calls.get(callId);
      
      if (!call) {
        return this.sendResponse(message, transport, 481, 'Call/Transaction Does Not Exist');
      }
      
      const otherTransport = transport === call.fromTransport ? call.toTransport : call.fromTransport;
      
      const forwardedCancel = SIPMessage.create({
        type: 'request',
        method: 'CANCEL',
        uri: transport === call.fromTransport ? call.to : call.from,
        headers: {
          ...message.headers,
          'via': `SIP/2.0/${otherTransport.protocol} ${this.options.domain};branch=${crypto.randomBytes(8).toString('hex')}`,
          'contact': `<sip:${this.options.domain}>`
        }
      });
      
      this.sendMessage(forwardedCancel, otherTransport);
      this.sendResponse(message, transport, 200, 'OK');
      
      this.calls.delete(callId);
    }
    
    handleOptions(message, transport) {
      this.sendResponse(message, transport, 200, 'OK', {
        'Allow': 'INVITE, ACK, CANCEL, BYE, REGISTER, OPTIONS',
        'Supported': 'path'
      });
    }
    
    sendResponse(request, transport, statusCode, reasonPhrase, additionalHeaders = {}, body = '') {
      const headers = {
        'via': request.headers.via,
        'from': request.headers.from,
        'to': request.headers.to,
        'call-id': request.headers['call-id'],
        'cseq': request.headers.cseq,
        'content-length': Buffer.byteLength(body).toString(),
        ...additionalHeaders
      };
      
      const response = SIPMessage.create({
        type: 'response',
        statusCode,
        reasonPhrase,
        headers,
        body
      });
      
      this.sendMessage(response, transport);
    }
    
    sendMessage(message, transport) {
      if (transport.protocol === 'udp') {
        this.udpServer.send(message, transport.port, transport.address);
      } else if (transport.protocol === 'tcp' && transport.socket) {
        transport.socket.write(message);
      }
    }
    
    setupMediaRelay(callId, call) {
      const fromSDP = this.parseSDP(call.fromSDP);
      const toSDP = this.parseSDP(call.toSDP);
      
      if (!fromSDP.media || !toSDP.media) return;
      
      const mediaRelay = {
        fromSocket: dgram.createSocket('udp4'),
        toSocket: dgram.createSocket('udp4'),
        close: function() {
          this.fromSocket.close();
          this.toSocket.close();
        }
      };
      
      mediaRelay.fromSocket.on('message', (msg, rinfo) => {
        mediaRelay.toSocket.send(msg, toSDP.media.port, toSDP.media.address);
      });
      
      mediaRelay.toSocket.on('message', (msg, rinfo) => {
        mediaRelay.fromSocket.send(msg, fromSDP.media.port, fromSDP.media.address);
      });
      
      mediaRelay.fromSocket.bind();
      mediaRelay.toSocket.bind();
      
      this.mediaRelays.set(callId, mediaRelay);
    }
    
    parseSDP(sdp) {
      const result = { media: null };
      
      const lines = sdp.split('\r\n');
      let mediaSection = false;
      
      for (const line of lines) {
        if (line.startsWith('m=audio')) {
          mediaSection = true;
          result.media = { type: 'audio', port: parseInt(line.split(' ')[1]) };
        } else if (mediaSection && line.startsWith('c=')) {
          result.media.address = line.split(' ')[2];
        }
      }
      
      return result;
    }
    
    close() {
      this.udpServer.close();
      this.tcpServer.close();
      
      for (const relay of this.mediaRelays.values()) {
        relay.close();
      }
      
      this.mediaRelays.clear();
    }
  }
  
  class VoIPESIMProvider {
    constructor(options = {}) {
      this.esimProvisioner = new ESIMProvisioner();
      this.sipServer = new SIPServer(options.sip || {});
      
      this.phoneNumberPrefix = options.phoneNumberPrefix || CONFIG.PHONE_NUMBER_PREFIX;
      this.nextPhoneNumberSuffix = 1000;
      
      this.phoneToProfile = new Map();
      this.loadPhoneNumberMappings();
      
      this.sipServer.on('message', this.handleSIPMessage.bind(this));
      this.sipServer.on('provision-request', this.handleProvisioningRequest.bind(this));
    }
    
    loadPhoneNumberMappings() {
      try {
        const dataPath = path.join(__dirname, CONFIG.DATA_DIR, 'phone_mappings.json');
        if (fs.existsSync(dataPath)) {
          const mappings = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
          this.phoneToProfile = new Map(mappings);
          
          let maxSuffix = 1000;
          for (const [phone] of this.phoneToProfile.entries()) {
            const suffix = parseInt(phone.substring(this.phoneNumberPrefix.length));
            if (suffix > maxSuffix) maxSuffix = suffix;
          }
          this.nextPhoneNumberSuffix = maxSuffix + 1;
        }
      } catch (err) {
        console.error('Error loading phone number mappings:', err);
      }
    }
    
    savePhoneNumberMappings() {
      try {
        const dataPath = path.join(__dirname, CONFIG.DATA_DIR, 'phone_mappings.json');
        const mappings = Array.from(this.phoneToProfile.entries());
        fs.writeFileSync(dataPath, JSON.stringify(mappings, null, 2));
      } catch (err) {
        console.error('Error saving phone number mappings:', err);
      }
    }
    
    provisionNewESIM() {
      const phoneNumber = this.phoneNumberPrefix + this.nextPhoneNumberSuffix++;
      const profile = this.esimProvisioner.createProfile(phoneNumber);
      
      this.phoneToProfile.set(phoneNumber, profile.iccid);
      this.savePhoneNumberMappings();
      
      const activationData = this.esimProvisioner.generateActivationData(profile.iccid);
      
      return {
        phoneNumber,
        profile,
        activationData
      };
    }
    
    getProfileByPhoneNumber(phoneNumber) {
      const iccid = this.phoneToProfile.get(phoneNumber);
      if (!iccid) return null;
      
      return this.esimProvisioner.getProfile(iccid);
    }
    
    handleSIPMessage(message, transport) {
      // Handle standard SIP messages
      if (!message.type || message.type !== 'request') return;
  
      const uri = message.uri || '';
      
      // Check for provisioning requests in the legacy format
      if (message.method === 'INVITE' && uri.includes(`@${CONFIG.SIP_SERVER_URL}`) && message.body && message.body.includes('PROVISION-ESIM')) {
        this.handleProvisioningRequest(message, transport);
      }
    }
    
    handleProvisioningRequest(message, transport) {
      const body = message.body || '';
      
      if (!body.includes('PROVISION-ESIM')) {
        return this.sipServer.sendResponse(message, transport, 400, 'Bad Request');
      }
      
      try {
        const provisioningData = this.provisionNewESIM();
        
        const responseBody = `ESIM-PROVISIONED\r\n
  Phone-Number: ${provisioningData.phoneNumber}
  ICCID: ${provisioningData.profile.iccid}
  IMSI: ${provisioningData.profile.imsi}
  Activation-Code: ${provisioningData.activationData.activationCode}
  SM-DP-Address: ${provisioningData.activationData.smDpPlusAddress}
  SIP-URL: ${provisioningData.activationData.sipServerUrl}
  Encoded-Profile: ${provisioningData.activationData.encodedActivationCode}
  `;
        
        this.sipServer.sendResponse(message, transport, 200, 'OK', {
          'Content-Type': 'application/esim-provision',
          'Content-Length': Buffer.byteLength(responseBody).toString()
        }, responseBody);
      } catch (err) {
        console.error('Error provisioning eSIM:', err);
        this.sipServer.sendResponse(message, transport, 500, 'Internal Server Error');
      }
    }
  }
  
  const API = {
    ESIMProvisioner,
    SIPServer,
    VoIPESIMProvider
  };
  
  module.exports = API;
  
  if (require.main === module) {
    // Create provider with default configurations from CONFIG
    const provider = new VoIPESIMProvider({
      sip: {
        domain: CONFIG.SIP_SERVER_URL,
        udpPort: CONFIG.SIP_SERVER_PORT,
        tcpPort: CONFIG.SIP_SERVER_PORT + 1
      },
      phoneNumberPrefix: CONFIG.PHONE_NUMBER_PREFIX
    });
    
    console.log(`VoIP eSIM Provisioning Server started at ${CONFIG.SIP_SERVER_URL}:${CONFIG.SIP_SERVER_PORT}`);
    console.log(`External calls ${provider.sipServer.allowOutboundCalls ? 'enabled' : 'disabled'}`);
    
    process.on('SIGINT', () => {
      console.log('Shutting down VLeSIM Provisioning Server...');
      provider.sipServer.close();
      process.exit(0);
    });
  }

  // Add this near the top with your other requires
const { MobileDataBridge, IntegratedMobileDataProvider } = require('./MobileDataBridge');

// In your startup code where require.main === module
if (require.main === module) {
  // Create VoIP provider (your existing code)
  const provider = new VoIPESIMProvider({
    sip: {
      domain: CONFIG.SIP_SERVER_URL,
      udpPort: CONFIG.SIP_SERVER_PORT,
      tcpPort: CONFIG.SIP_SERVER_PORT + 1
    },
    phoneNumberPrefix: CONFIG.PHONE_NUMBER_PREFIX
  });
  
  // Add this new part - create the integrated provider
  const integratedProvider = new IntegratedMobileDataProvider(provider, {
    ip: CONFIG.SIP_SERVER_URL,
    port: CONFIG.SIP_SERVER_PORT + 2,
    apn: 'private.network.apn'
  });
  
  console.log(`VoIP eSIM Provisioning Server started at ${CONFIG.SIP_SERVER_URL}:${CONFIG.SIP_SERVER_PORT}`);
  console.log(`Mobile Data Bridge started at ${CONFIG.SIP_SERVER_URL}:${CONFIG.SIP_SERVER_PORT + 2}`);
  console.log(`External calls ${provider.sipServer.allowOutboundCalls ? 'enabled' : 'disabled'}`);
  
  // In your shutdown handler
  process.on('SIGINT', () => {
    console.log('Shutting down VLeSIM servers...');
    provider.sipServer.close();
    integratedProvider.close(); // Add this to properly close the data bridge
    process.exit(0);
  });
}