const dgram = require('dgram');
const blessed = require('blessed');

const client = dgram.createSocket('udp4');
const SERVER_HOST = 'vlesim.onrender.com'; // Remove protocol
const SERVER_PORT = 5060;

// UI setup
const screen = blessed.screen({
  smartCSR: true,
  title: 'eSIM Provisioner'
});

const logBox = blessed.log({
  top: '0',
  left: 'center',
  width: '100%',
  height: '90%',
  border: 'line',
  label: ' Logs ',
  tags: true,
  scrollable: true,
  scrollbar: {
    ch: ' ',
    track: {
      bg: 'grey'
    },
    style: {
      inverse: true
    }
  }
});

const statusBar = blessed.box({
  bottom: 0,
  height: '10%',
  width: '100%',
  content: 'Press {bold}q{/bold} to exit',
  tags: true,
  style: {
    fg: 'white',
    bg: 'blue'
  }
});

screen.append(logBox);
screen.append(statusBar);
screen.render();

function log(message) {
  logBox.log(message);
  screen.render();
}

function provisionESIM() {
  const inviteMessage = 
    'INVITE sip:provision@vlesim.onrender.com SIP/2.0\r\n' +
    'Via: SIP/2.0/UDP client.local;branch=z9hG4bK-test\r\n' +
    'From: <sip:client@client.local>;tag=test\r\n' +
    'To: <sip:provision@vlesim.onrender.com>\r\n' +
    'Call-ID: test-call-id\r\n' +
    'CSeq: 1 INVITE\r\n' +
    'Contact: <sip:client@client.local>\r\n' +
    'Content-Type: text/plain\r\n' +
    'Content-Length: 13\r\n' +
    '\r\n' +
    'PROVISION-ESIM';

  client.send(Buffer.from(inviteMessage), SERVER_PORT, SERVER_HOST, (err) => {
    if (err) {
      log(`{red-fg}Error sending request: ${err}{/red-fg}`);
      client.close();
    } else {
      log('{green-fg}Provisioning request sent{/green-fg}');
    }
  });
}

client.on('message', (msg, rinfo) => {
  log(`{cyan-fg}Received response from ${rinfo.address}:${rinfo.port}{/cyan-fg}`);
  
  const response = msg.toString();
  log(`\nResponse:\n${response}`);
  
  if (response.includes('ESIM-PROVISIONED')) {
    const lines = response.split('\n');
    const profileData = {};
    
    lines.forEach(line => {
      if (line.includes(':')) {
        const [key, value] = line.split(':', 2);
        profileData[key.trim()] = value.trim();
      }
    });
    
    log(`{yellow-fg}\nProvisioned eSIM Profile:{/yellow-fg}`);
    log(JSON.stringify(profileData, null, 2));
  }

  client.close();
});

client.on('listening', () => {
  const address = client.address();
  log(`Client listening on ${address.address}:${address.port}`);
  provisionESIM();
});

client.bind();

// Exit on 'q'
screen.key(['q', 'C-c'], function () {
  client.close();
  process.exit(0);
});
