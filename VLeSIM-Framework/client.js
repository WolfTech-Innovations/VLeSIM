const dgram = require('dgram');
const client = dgram.createSocket('udp4');
const https = require('https');

const SERVER_HOST = "0.0.0.0";
const SERVER_PORT = 5052;
// Replace the require with dynamic import
(async () => {
  try {
    // Dynamically import the public-ip module
    const publicIp = await import('public-ip');
    
    // Use the imported module to get the public IP
    CONFIG.SERVER_HOST = await publicIp.publicIpv4();
    console.log('CONFIG updated with public IP:', CONFIG);
  } catch (err) {
    console.error('Could not get public IP:', err);
  }
})();
function provisionESIM() {
  // Create a simple SIP INVITE message for provisioning
  const inviteMessage = 
    'INVITE sip:provision@0.0.0.0 SIP/2.0\r\n' +
    'Via: SIP/2.0/UDP client.local;branch=z9hG4bK-test\r\n' +
    'From: <sip:client@client.local>;tag=test\r\n' +
    'To: <sip:provision@0.0.0.0>\r\n' +
    'Call-ID: test-call-id\r\n' +
    'CSeq: 1 INVITE\r\n' +
    'Contact: <sip:client@client.local>\r\n' +
    'Content-Type: text/plain\r\n' +
    'Content-Length: 13\r\n' +
    '\r\n' +
    'PROVISION-ESIM';

  client.send(Buffer.from(inviteMessage), SERVER_PORT, SERVER_HOST, (err) => {
    if (err) {
      console.error('Error sending request:', err);
      client.close();
    } else {
      console.log('Provisioning request sent');
    }
  });
}

// Handle incoming responses
client.on('message', (msg, rinfo) => {
  console.log(`Received response from ${rinfo.address}:${rinfo.port}`);
  
  const response = msg.toString();
  console.log('\nResponse:\n', response);
  
  // Extract the relevant information
  if (response.includes('ESIM-PROVISIONED')) {
    const lines = response.split('\n');
    const profileData = {};
    
    lines.forEach(line => {
      if (line.includes(':')) {
        const [key, value] = line.split(':', 2);
        profileData[key.trim()] = value.trim();
      }
    });
    
    console.log('\nProvisioned eSIM Profile:');
    console.log(JSON.stringify(profileData, null, 2));
  }
  
  client.close();
});

client.on('listening', () => {
  const address = client.address();
  console.log(`Client listening on ${address.address}:${address.port}`);
  provisionESIM();
});

// Bind to any available port
client.bind();
