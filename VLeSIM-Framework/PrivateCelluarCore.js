const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const execAsync = util.promisify(exec);

// Helper to run shell commands and log output
async function run(cmd) {
  try {
    const { stdout, stderr } = await execAsync(cmd);
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error(stderr.trim());
  } catch (err) {
    console.error(`[!] Command failed: ${cmd}\n${err.message}`);
  }
}

// Request root permission first
async function requestSudo() {
  console.log('[*] Requesting sudo/root permission...');
  await run('sudo -v');
}

// Create a TUN device
async function createTun(name = 'tun0') {
  console.log(`[+] Setting up TUN interface: ${name}`);
  await run(`sudo ip tuntap add dev ${name} mode tun`);
  await run(`sudo ip addr add 10.0.0.1/24 dev ${name}`);
  await run(`sudo ip link set ${name} up`);
}

// Create a virtual cellular interface
async function createVirtualCell(name = 'cell0', ip = '10.1.0.1/24') {
  console.log(`[+] Creating virtual cellular interface: ${name}`);
  await run(`sudo ip link add ${name} type dummy`);
  await run(`sudo ip addr add ${ip} dev ${name}`);
  await run(`sudo ip link set ${name} up`);
}

// Create multiple virtual cellular interfaces
async function createMultipleCells(count = 2) {
  for (let i = 0; i < count; i++) {
    const name = `cell${i}`;
    const ip = `10.1.${i}.1/24`;
    await createVirtualCell(name, ip);
  }
}

async function runServer2() {
  const serverPath = path.join(__dirname, 'MobileDeviceAdapter.js');
  console.log('[*] Starting MobileDeviceAdapter.js...');
  const server = exec(`node ${serverPath} &`);
  server.stdout.pipe(process.stdout);
  server.stderr.pipe(process.stderr);
}

// Launch the main server afterward
async function runServer() {
  const serverPath = path.join(__dirname, 'Server.js');
  console.log('[*] Starting Server.js...');
  const server = exec(`node ${serverPath} `);
  server.stdout.pipe(process.stdout);
  server.stderr.pipe(process.stderr);
}

// Main flow
(async () => {
  await requestSudo();

  try {
    await createTun();
    await createMultipleCells(3); // Creates cell0, cell1, cell2
  } catch (err) {
    console.error(`[!] Setup failed: ${err.message}`);
  } finally {
    await runServer();
  }
})();
