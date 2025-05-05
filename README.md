# VoIP eSIM Framework

A lightweight framework for provisioning virtual eSIMs with integrated VoIP and mobile data capabilities.

## Overview

The VoIP eSIM Framework provides a complete solution for creating, managing, and provisioning virtual eSIM profiles with built-in VoIP (Voice over IP) functionality. It enables developers to implement software-based SIM cards that can handle voice calls and mobile data services without requiring physical SIM hardware.

## Features

- **Virtual eSIM Provisioning**: Generate and manage virtual eSIM profiles with ICCID, IMSI, and authentication keys
- **SIP Server**: Built-in SIP (Session Initiation Protocol) server for handling voice calls
- **Mobile Data Bridge**: Integrated data connectivity services for internet access
- **External Call Routing**: Support for routing calls to external SIP networks
- **Media Relay**: Handles audio streaming between call participants

## Components

### ESIMProvisioner

Responsible for creating and managing eSIM profiles:
- Generates cryptographically secure ICCID, IMSI, Ki, and OPc values
- Maintains profile database with persistence
- Provides activation data for device onboarding

### SIPServer

Handles SIP signaling for voice calls:
- Supports both UDP and TCP transports
- Manages user registrations
- Routes calls between registered users
- Handles call setup, maintenance, and termination
- Routes external calls to other SIP networks

### VoIPESIMProvider

Top-level component that integrates provisioning and communication:
- Manages phone number allocation
- Handles eSIM provisioning requests via SIP
- Links phone numbers to eSIM profiles

### IntegratedMobileDataProvider

Provides data connectivity for provisioned eSIMs:
- Handles APN (Access Point Name) configuration
- Manages data sessions
- Integrates with the VoIP system

## Configuration

The framework uses the following default configuration:

```javascript
const CONFIG = {
  SIP_SERVER_URL: '0.0.0.0', // Automatically updated to public IP
  SIP_SERVER_PORT: 5052,
  SIP_SERVER_PROTOCOL: 'udp',
  PHONE_NUMBER_PREFIX: '935',
  DATA_DIR: './data'
};
```

## Usage

### Basic Setup

```javascript
const { VoIPESIMProvider } = require('./voip-esim-framework');

// Create provider with default configurations
const provider = new VoIPESIMProvider({
  sip: {
    domain: 'your-sip-domain.com',
    udpPort: 5052,
    tcpPort: 5053
  },
  phoneNumberPrefix: '935'
});

console.log(`VoIP eSIM Provisioning Server started`);
```

### Provisioning a New eSIM

```javascript
const provisioningData = provider.provisionNewESIM();

console.log(`New eSIM provisioned:`);
console.log(`- Phone Number: ${provisioningData.phoneNumber}`);
console.log(`- ICCID: ${provisioningData.profile.iccid}`);
console.log(`- SIP URL: ${provisioningData.activationData.sipServerUrl}`);
console.log(`- Activation Code: ${provisioningData.activationData.activationCode}`);
```

### With Mobile Data Bridge

```javascript
const { VoIPESIMProvider, IntegratedMobileDataProvider } = require('./voip-esim-framework');

// Create VoIP provider
const provider = new VoIPESIMProvider({/* config */});

// Add mobile data capabilities
const integratedProvider = new IntegratedMobileDataProvider(provider, {
  ip: 'your-server-ip',
  port: 5054,
  apn: 'private.network.apn'
});
```

## Client Integration

Clients can request eSIM provisioning by sending a special SIP INVITE message:

```
INVITE sip:provision@your-sip-domain.com SIP/2.0
...headers...

PROVISION-ESIM
```

The server responds with the eSIM profile data:

```
SIP/2.0 200 OK
...headers...
Content-Type: application/esim-provision

ESIM-PROVISIONED

Phone-Number: 935xxxx
ICCID: 00000000000
IMSI: 0000000000000
Activation-Code: a1b2c3d4e5f6
SM-DP-Address: your-sip-domain.com
SIP-URL: sip:9351001@your-sip-domain.com:5052;transport=udp
Encoded-Profile: base64encodedprofiledata
```

## Installation

1. Clone the repository
2. Install dependencies: `npm install`
3. Run the server: `node index.js`

## Dependencies

- Node.js (v14+)
- Required npm packages:
  - `public-ip`: For automatic public IP detection
  - Standard Node.js modules: fs, path, crypto, dgram, net, events

## License

[MIT License](LICENSE)