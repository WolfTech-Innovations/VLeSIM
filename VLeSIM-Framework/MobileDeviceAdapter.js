// MobileDeviceAdapter.js - Provides compatibility between UDP-based server and mobile phones
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qrcode = require('qrcode');
const { execSync } = require('child_process');

/**
 * MobileDeviceAdapter - Connects Android and iOS devices to UDP-based eSIM server
 * Acts as an intermediary for devices that cannot directly use UDP SIP messaging
 */
class MobileDeviceAdapter {
  constructor(options = {}) {
    this.options = {
      serverHost: options.serverHost || '0.0.0.0',
      serverPort: options.serverPort || 5052,
      adapterPort: options.adapterPort || 5053,
      dataPath: options.dataPath || path.join(__dirname, './data/mobile_devices'),
      qrPath: options.qrPath || path.join(__dirname, './data/qrcodes'),
      ...options
    };
    
    // Create necessary directories
    this.ensureDirectories();
    
    // UDP client to communicate with the eSIM provisioning server
    this.serverClient = dgram.createSocket('udp4');
    
    // UDP server to listen for device communications
    this.deviceServer = dgram.createSocket('udp4');
    
    // Device registration tracking
    this.devices = new Map();
    
    // Load existing devices
    this.loadDevices();
    
    // Setup the UDP servers
    this.setupServerClient();
    this.setupDeviceServer();
  }
  
  ensureDirectories() {
    if (!fs.existsSync(this.options.dataPath)) {
      fs.mkdirSync(this.options.dataPath, { recursive: true });
    }
    
    if (!fs.existsSync(this.options.qrPath)) {
      fs.mkdirSync(this.options.qrPath, { recursive: true });
    }
  }
  
  loadDevices() {
    try {
      const files = fs.readdirSync(this.options.dataPath);
      files.forEach(file => {
        if (file.endsWith('.json')) {
          const deviceData = JSON.parse(fs.readFileSync(path.join(this.options.dataPath, file), 'utf8'));
          this.devices.set(deviceData.deviceId, deviceData);
        }
      });
      console.log(`Loaded ${this.devices.size} device registrations`);
    } catch (err) {
      console.error('Error loading device data:', err);
    }
  }
  
  saveDevice(deviceId, deviceData) {
    const filePath = path.join(this.options.dataPath, `${deviceId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(deviceData, null, 2));
    this.devices.set(deviceId, deviceData);
  }
  
  setupServerClient() {
    this.serverClient.on('message', (msg, rinfo) => {
      // Process response from the eSIM server
      const response = msg.toString();
      console.log(`Received from eSIM server (${rinfo.address}:${rinfo.port}):\n`, response);
      
      // Handle provisioning responses
      if (response.includes('ESIM-PROVISIONED')) {
        this.handleProvisioningResponse(response);
      }
    });
    
    this.serverClient.on('error', (err) => {
      console.error('Server client error:', err);
    });
    
    // Bind to random port
    this.serverClient.bind();
  }
  
  setupDeviceServer() {
    this.deviceServer.on('message', (msg, rinfo) => {
      // Process message from a mobile device
      console.log(`Received from device (${rinfo.address}:${rinfo.port}):\n`, msg.toString());
      
      try {
        const request = JSON.parse(msg.toString());
        this.handleDeviceRequest(request, rinfo);
      } catch (err) {
        console.error('Error parsing device message:', err);
        // Send error response
        const errorResponse = JSON.stringify({
          status: 'error',
          error: 'Invalid request format'
        });
        this.deviceServer.send(errorResponse, rinfo.port, rinfo.address);
      }
    });
    
    this.deviceServer.on('error', (err) => {
      console.error('Device server error:', err);
    });
    
    this.deviceServer.on('listening', () => {
      const address = this.deviceServer.address();
      console.log(`Mobile Device Adapter listening on ${address.address}:${address.port}`);
    });
    
    // Bind to the adapter port
    this.deviceServer.bind(this.options.adapterPort);
  }
  
  handleDeviceRequest(request, rinfo) {
    const { action, deviceType, deviceId = crypto.randomUUID() } = request;
    
    switch (action) {
      case 'provision':
        this.provisionDevice(deviceId, deviceType, rinfo);
        break;
      case 'register':
        this.registerDevice(deviceId, deviceType, request.deviceInfo, rinfo);
        break;
      case 'status':
        this.checkDeviceStatus(deviceId, rinfo);
        break;
      default:
        const errorResponse = JSON.stringify({
          status: 'error',
          error: 'Unknown action'
        });
        this.deviceServer.send(errorResponse, rinfo.port, rinfo.address);
    }
  }
  
  provisionDevice(deviceId, deviceType, rinfo) {
    console.log(`Provisioning new eSIM for device ${deviceId} (${deviceType})`);
    
    // Create a SIP INVITE message for provisioning
    const inviteMessage = 
      'INVITE sip:provision@' + this.options.serverHost + ' SIP/2.0\r\n' +
      'Via: SIP/2.0/UDP adapter.local;branch=z9hG4bK-' + deviceId + '\r\n' +
      'From: <sip:adapter@adapter.local>;tag=' + deviceId + '\r\n' +
      'To: <sip:provision@' + this.options.serverHost + '>\r\n' +
      'Call-ID: ' + deviceId + '\r\n' +
      'CSeq: 1 INVITE\r\n' +
      'Contact: <sip:adapter@adapter.local>\r\n' +
      'Content-Type: text/plain\r\n' +
      'Content-Length: 13\r\n' +
      '\r\n' +
      'PROVISION-ESIM';
    
    // Store the request information for when we get a response
    this.saveDevice(deviceId, {
      deviceId,
      deviceType: deviceType || 'unknown',
      status: 'provisioning',
      clientAddress: rinfo.address,
      clientPort: rinfo.port,
      timestamp: Date.now()
    });
    
    // Send provisioning request to the eSIM server
    this.serverClient.send(
      Buffer.from(inviteMessage), 
      this.options.serverPort, 
      this.options.serverHost, 
      (err) => {
        if (err) {
          console.error('Error sending provisioning request:', err);
          
          // Notify device of error
          const errorResponse = JSON.stringify({
            status: 'error',
            error: 'Failed to send provisioning request'
          });
          this.deviceServer.send(errorResponse, rinfo.port, rinfo.address);
        } else {
          console.log('Provisioning request sent for device', deviceId);
          
          // Acknowledge receipt of request
          const ackResponse = JSON.stringify({
            status: 'pending',
            message: 'Provisioning request sent, awaiting response',
            deviceId
          });
          this.deviceServer.send(ackResponse, rinfo.port, rinfo.address);
        }
      }
    );
  }
  
  handleProvisioningResponse(response) {
    // Parse the response
    const lines = response.split('\n');
    const profileData = {};
    let deviceId = '';
    
    // Extract Call-ID which contains our deviceId
    const callIdMatch = response.match(/Call-ID:\s*([^\r\n]+)/i);
    if (callIdMatch && callIdMatch[1]) {
      deviceId = callIdMatch[1].trim();
    }
    
    // Parse the ESIM-PROVISIONED section
    let inProvisionedSection = false;
    lines.forEach(line => {
      if (line.includes('ESIM-PROVISIONED')) {
        inProvisionedSection = true;
        return;
      }
      
      if (inProvisionedSection && line.includes(':')) {
        const [key, value] = line.split(':', 2);
        profileData[key.trim()] = value.trim();
      }
    });
    
    // Find the device this response is for
    const deviceData = this.devices.get(deviceId);
    if (!deviceData) {
      console.error('Received provisioning response for unknown device:', deviceId);
      return;
    }
    
    // Update device data with profile information
    const updatedDeviceData = {
      ...deviceData,
      status: 'provisioned',
      profile: profileData,
      lastUpdated: Date.now()
    };
    
    // Save the updated device data
    this.saveDevice(deviceId, updatedDeviceData);
    
    // Generate device-specific activation content
    this.generateDeviceActivation(deviceId, updatedDeviceData);
    
    // Notify the device if it's still connected
    if (deviceData.clientAddress && deviceData.clientPort) {
      const successResponse = JSON.stringify({
        status: 'success',
        deviceId,
        profile: {
          phoneNumber: profileData['Phone-Number'],
          iccid: profileData.ICCID,
          activationCode: this.formatActivationCode(profileData['Encoded-Profile'], deviceData.deviceType)
        }
      });
      
      this.deviceServer.send(
        successResponse, 
        deviceData.clientPort, 
        deviceData.clientAddress
      );
    }
  }
  
  formatActivationCode(encodedProfile, deviceType) {
    // Different formats for different device types
    let profile;
    try {
      profile = JSON.parse(Buffer.from(encodedProfile, 'base64').toString());
    } catch (err) {
      console.error('Error parsing encoded profile:', err);
      return encodedProfile; // Return original if parsing fails
    }
    
    const smDpAddress = profile.sipServerUrl.split('@')[1].split(':')[0];
    
    switch ((deviceType || '').toLowerCase()) {
      case 'ios':
        // iOS format: LPA:1$smdp.example.com$MATCHING-ID$CONFIRMATION-CODE
        return `LPA:1$${smDpAddress}$${profile.iccid}$${profile.ki.substring(0, 8)}`;
        
      case 'android':
        // Android format: SM-DP+:address:matching-id:confirmation-code
        return `SM-DP+:${smDpAddress}:${profile.iccid}:${profile.ki.substring(0, 8)}`;
        
      default:
        // Universal format
        return `LPA:1$${smDpAddress}$${profile.iccid}$${profile.ki.substring(0, 8)}`;
    }
  }
  
  generateDeviceActivation(deviceId, deviceData) {
    const { deviceType = 'universal', profile } = deviceData;
    
    if (!profile) return;
    
    const activationCode = this.formatActivationCode(profile['Encoded-Profile'], deviceType);
    
    // Generate QR code for activation
    const qrPath = path.join(this.options.qrPath, `${deviceId}.png`);
    qrcode.toFile(qrPath, activationCode, {
      errorCorrectionLevel: 'H',
      margin: 1,
      width: 300
    }, (err) => {
      if (err) {
        console.error('Error generating QR code:', err);
      } else {
        console.log(`QR code generated for device ${deviceId} at ${qrPath}`);
        deviceData.qrPath = qrPath;
        this.saveDevice(deviceId, deviceData);
      }
    });
    
    // Generate device-specific installation instructions
    let instructions = '';
    switch ((deviceType || '').toLowerCase()) {
      case 'ios':
        instructions = this.generateIOSInstructions(activationCode, profile);
        break;
      case 'android':
        instructions = this.generateAndroidInstructions(activationCode, profile);
        break;
      default:
        instructions = this.generateUniversalInstructions(activationCode, profile);
    }
    
    const instructionsPath = path.join(this.options.dataPath, `${deviceId}_instructions.txt`);
    fs.writeFileSync(instructionsPath, instructions);
    deviceData.instructionsPath = instructionsPath;
    this.saveDevice(deviceId, deviceData);
  }
  
  generateIOSInstructions(activationCode, profile) {voip-esim-frameworkvoip-esim-framework
    return `
iPhone/iPad eSIM Installation Instructions
=========================================

1. Go to Settings > Cellular > Add Cellular Plan
2. Scan this QR code or manually enter the activation code:
   ${activationCode}
3. Follow the on-screen instructions to complete installation
4. Your phone number is: ${profile['Phone-Number']}
5. SIP Server URL: ${profile['SIP-URL']}

For troubleshooting, contact support with your ICCID: ${profile.ICCID}
`;
  }
  
  generateAndroidInstructions(activationCode, profile) {
    return `
Android eSIM Installation Instructions
====================================

1. Go to Settings > Network & Internet > SIMs > Add eSIM
2. Scan this QR code or manually enter the activation code:
   ${activationCode}
3. Follow the on-screen instructions to complete installation
4. Your phone number is: ${profile['Phone-Number']}
5. SIP Server URL: ${profile['SIP-URL']}

For some Android devices, you may need to go to Settings > Connections > SIM Manager > Add eSIM

For troubleshooting, contact support with your ICCID: ${profile.ICCID}
`;
  }
  
  generateUniversalInstructions(activationCode, profile) {
    return `
eSIM Installation Instructions
============================

For iPhone/iPad:
1. Go to Settings > Cellular > Add Cellular Plan
2. Scan the QR code or manually enter the activation code

For Android:
1. Go to Settings > Network & Internet > SIMs > Add eSIM
   (or Settings > Connections > SIM Manager > Add eSIM on Samsung)
2. Scan the QR code or manually enter the activation code

Activation Code: ${activationCode}
Phone Number: ${profile['Phone-Number']}
SIP Server URL: ${profile['SIP-URL']}

For troubleshooting, contact support with your ICCID: ${profile.ICCID}
`;
  }
  
  registerDevice(deviceId, deviceType, deviceInfo, rinfo) {
    const existingDevice = this.devices.get(deviceId);
    
    if (!existingDevice) {
      const response = JSON.stringify({
        status: 'error',
        error: 'Device not found. Please provision first.'
      });
      this.deviceServer.send(response, rinfo.port, rinfo.address);
      return;
    }
    
    // Update device information
    const updatedDevice = {
      ...existingDevice,
      deviceType: deviceType || existingDevice.deviceType,
      deviceInfo: {
        ...existingDevice.deviceInfo,
        ...deviceInfo
      },
      status: 'registered',
      lastSeen: Date.now(),
      clientAddress: rinfo.address,
      clientPort: rinfo.port
    };
    
    this.saveDevice(deviceId, updatedDevice);
    
    // Respond with success
    const response = JSON.stringify({
      status: 'success',
      message: 'Device registered successfully',
      deviceId
    });
    this.deviceServer.send(response, rinfo.port, rinfo.address);
  }
  
  checkDeviceStatus(deviceId, rinfo) {
    const deviceData = this.devices.get(deviceId);
    
    if (!deviceData) {
      const response = JSON.stringify({
        status: 'error',
        error: 'Device not found'
      });
      this.deviceServer.send(response, rinfo.port, rinfo.address);
      return;
    }
    
    // Update last seen time
    deviceData.lastSeen = Date.now();
    this.saveDevice(deviceId, deviceData);
    
    // Send status response
    const statusResponse = JSON.stringify({
      status: 'success',
      deviceId,
      deviceStatus: deviceData.status,
      profile: deviceData.profile ? {
        phoneNumber: deviceData.profile['Phone-Number'],
        iccid: deviceData.profile.ICCID
      } : null
    });
    
    this.deviceServer.send(statusResponse, rinfo.port, rinfo.address);
  }
  
  close() {
    if (this.serverClient) {
      this.serverClient.close();
    }
    
    if (this.deviceServer) {
      this.deviceServer.close();
    }
  }
}

/**
 * NetworkSetupTools - Utilities for setting up network components for cellular simulation
 */
class NetworkSetupTools {
  constructor() {
    this.isRoot = process.getuid && process.getuid() === 0;
    
    if (!this.isRoot) {
      console.warn('Warning: Some network setup functions require root privileges');
    }
  }
  
  /**
   * Creates a virtual cellular network interface
   */
  createCellularInterface(name = 'cell0', ip = '10.10.0.1/24') {
    if (!this.isRoot) {
      return { success: false, error: 'Root privileges required' };
    }
    
    try {
      // Check if interface already exists
      try {
        const checkResult = execSync(`ip link show ${name}`).toString();
        if (checkResult) {
          console.log(`Interface ${name} already exists`);
          return { success: true, message: 'Interface already exists' };
        }
      } catch (e) {
        // Interface doesn't exist, continue with creation
      }
      
      // Create the interface
      execSync(`ip tuntap add dev ${name} mode tun`);
      execSync(`ip addr add ${ip} dev ${name}`);
      execSync(`ip link set ${name} up`);
      
      return { success: true };
    } catch (err) {
      console.error(`Failed to create cellular interface: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
  
  /**
   * Sets up NAT for the private network
   */
  setupNAT(interfaceName = 'cell0', outInterface = 'eth0') {
    if (!this.isRoot) {
      return { success: false, error: 'Root privileges required' };
    }
    
    try {
      // Enable IP forwarding
      execSync('echo 1 > /proc/sys/net/ipv4/ip_forward');
      
      // Set up NAT with iptables
      execSync(`iptables -t nat -A POSTROUTING -o ${outInterface} -j MASQUERADE`);
      execSync(`iptables -A FORWARD -i ${interfaceName} -o ${outInterface} -j ACCEPT`);
      execSync(`iptables -A FORWARD -i ${outInterface} -o ${interfaceName} -m state --state RELATED,ESTABLISHED -j ACCEPT`);
      
      return { success: true };
    } catch (err) {
      console.error(`Failed to set up NAT: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
  
  /**
   * Sets up DNS for the private network
   */
  setupDNS(interfaceName = 'cell0', dnsPort = 5354) {
    if (!this.isRoot) {
      return { success: false, error: 'Root privileges required' };
    }
    
    try {
      // Redirect DNS queries to our DNS server
      execSync(`iptables -t nat -A PREROUTING -i ${interfaceName} -p udp --dport 53 -j REDIRECT --to-port ${dnsPort}`);
      
      return { success: true };
    } catch (err) {
      console.error(`Failed to set up DNS redirection: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}

// Client library for mobile apps to connect to the adapter
class MobileConnectionClient {
  constructor(serverAddress, serverPort = 5053) {
    this.serverAddress = serverAddress;
    this.serverPort = serverPort;
    this.deviceId = null;
    this.client = dgram.createSocket('udp4');
    this.setupClient();
  }
  
  setupClient() {
    this.client.on('message', (msg, rinfo) => {
      try {
        const response = JSON.parse(msg.toString());
        console.log('Received response:', response);
        
        if (response.deviceId) {
          this.deviceId = response.deviceId;
        }
        
        // Handle response based on status
        if (response.status === 'success' && response.profile) {
          console.log('eSIM Profile received!');
          // Display activation information
          this.displayActivationInfo(response.profile);
        }
      } catch (err) {
        console.error('Error processing server response:', err);
      }
    });
    
    this.client.on('error', (err) => {
      console.error('Client error:', err);
    });
    
    // Bind to any available port
    this.client.bind();
  }
  
  async provisionESIM(deviceType) {
    return new Promise((resolve, reject) => {
      // Prepare the request
      const request = {
        action: 'provision',
        deviceType: deviceType || this.detectDeviceType(),
        deviceId: this.deviceId || crypto.randomUUID()
      };
      
      // Send the request
      this.client.send(
        JSON.stringify(request),
        this.serverPort,
        this.serverAddress,
        (err) => {
          if (err) {
            reject(err);
          } else {
            console.log('Provisioning request sent');
            resolve({ deviceId: request.deviceId, status: 'pending' });
          }
        }
      );
    });
  }
  
  async checkStatus() {
    if (!this.deviceId) {
      throw new Error('No device ID available. Please provision first');
    }
    
    return new Promise((resolve, reject) => {
      // Prepare the request
      const request = {
        action: 'status',
        deviceId: this.deviceId
      };
      
      // Send the request
      this.client.send(
        JSON.stringify(request),
        this.serverPort,
        this.serverAddress,
        (err) => {
          if (err) {
            reject(err);
          } else {
            console.log('Status request sent');
            resolve({ status: 'pending' });
          }
        }
      );
    });
  }
  
  detectDeviceType() {
    // Simple platform detection
    if (typeof navigator !== 'undefined') {
      const userAgent = navigator.userAgent || '';
      if (/iPhone|iPad|iPod/.test(userAgent)) {
        return 'ios';
      } else if (/Android/.test(userAgent)) {
        return 'android';
      }
    }
    return 'unknown';
  }
  
  displayActivationInfo(profile) {
    console.log('\neSIM Activation Information:');
    console.log(`Phone Number: ${profile.phoneNumber}`);
    console.log(`ICCID: ${profile.iccid}`);
    console.log(`Activation Code: ${profile.activationCode}`);
    console.log('\nTo activate your eSIM:');
    console.log('1. Go to your device settings');
    console.log('2. Add a cellular plan');
    console.log('3. Enter the activation code above or scan the QR code');
  }
  
  close() {
    if (this.client) {
      this.client.close();
    }
  }
}

module.exports = {
  MobileDeviceAdapter,
  NetworkSetupTools,
  MobileConnectionClient
};

// Example usage when run directly
if (require.main === module) {
  const adapter = new MobileDeviceAdapter({
    serverHost: process.env.SERVER_HOST || '0.0.0.0',
    serverPort: parseInt(process.env.SERVER_PORT || '5056'),
    adapterPort: parseInt(process.env.ADAPTER_PORT || '5058')
  });
  
  console.log('Mobile Device Adapter started');
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down Mobile Device Adapter...');
    adapter.close();
    process.exit(0);
  });
}