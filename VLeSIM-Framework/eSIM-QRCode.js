/**
 * eSIM QRCode Generator
 * 
 * This module generates QR codes for eSIM profiles based on the JSON data stored in the esims/ directory.
 * It follows the GSMA SGP.22 standard format for eSIM activation codes.
 */

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const CONFIG = {
  DATA_DIR: './data',
  SM_DP_PLUS_ADDRESS: process.env.SM_DP_PLUS_ADDRESS || '0.0.0.0',
  OUTPUT_DIR: './qrcodes'
};

class ESIMQRCodeGenerator {
  constructor(options = {}) {
    this.dataPath = options.dataPath || path.join(__dirname, CONFIG.DATA_DIR, 'esims');
    this.outputPath = options.outputPath || path.join(__dirname, CONFIG.OUTPUT_DIR);
    this.smDpPlusAddress = options.smDpPlusAddress || CONFIG.SM_DP_PLUS_ADDRESS;
    
    // Ensure the output directory exists
    if (!fs.existsSync(this.outputPath)) {
      fs.mkdirSync(this.outputPath, { recursive: true });
    }
  }

  /**
   * Load a specific eSIM profile by ICCID
   * @param {string} iccid - The ICCID of the eSIM profile
   * @returns {Object|null} The eSIM profile object or null if not found
   */
  loadProfile(iccid) {
    try {
      const filePath = path.join(this.dataPath, `${iccid}.json`);
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
      return null;
    } catch (err) {
      console.error(`Error loading eSIM profile ${iccid}:`, err);
      return null;
    }
  }

  /**
   * Load all eSIM profiles from the data directory
   * @returns {Array} Array of eSIM profile objects
   */
  loadAllProfiles() {
    try {
      const files = fs.readdirSync(this.dataPath);
      const profiles = [];
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const profile = JSON.parse(fs.readFileSync(path.join(this.dataPath, file), 'utf8'));
          profiles.push(profile);
        }
      }
      
      return profiles;
    } catch (err) {
      console.error('Error loading eSIM profiles:', err);
      return [];
    }
  }

  /**
   * Generate a unique activation code for an eSIM profile
   * @param {Object} profile - The eSIM profile
   * @returns {string} The activation code
   */
  generateActivationCode(profile) {
    // Format: LPA:1$<SM-DP+ address>$<matching ID>$<SMDP generated code>
    const matchingId = profile.iccid;
    const smdpCode = Buffer.from(JSON.stringify({
      iccid: profile.iccid,
      imsi: profile.imsi,
      ki: profile.ki,
      opc: profile.opc,
      msisdn: profile.msisdn
    })).toString('base64').substring(0, 20);
    
    return `LPA:1$${this.smDpPlusAddress}$${matchingId}$${smdpCode}`;
  }

  /**
   * Generate a QR code image from an activation code
   * @param {string} activationCode - The eSIM activation code
   * @param {string} outputPath - The path to save the QR code image
   * @returns {Promise<void>}
   */
  async generateQRCode(activationCode, outputPath) {
    try {
      await QRCode.toFile(outputPath, activationCode, {
        errorCorrectionLevel: 'H',
        margin: 1,
        scale: 8
      });
      console.log(`QR code generated successfully: ${outputPath}`);
      return outputPath;
    } catch (err) {
      console.error('Error generating QR code:', err);
      throw err;
    }
  }

  /**
   * Generate QR code for a specific eSIM profile
   * @param {string} iccid - The ICCID of the eSIM profile
   * @returns {Promise<string|null>} The path to the generated QR code or null if failed
   */
  async generateQRCodeForProfile(iccid) {
    const profile = this.loadProfile(iccid);
    if (!profile) {
      console.error(`Profile with ICCID ${iccid} not found`);
      return null;
    }
    
    const activationCode = this.generateActivationCode(profile);
    const outputPath = path.join(this.outputPath, `esim_${profile.iccid}_${profile.msisdn}.png`);
    
    try {
      await this.generateQRCode(activationCode, outputPath);
      return outputPath;
    } catch (err) {
      return null;
    }
  }

  /**
   * Generate QR codes for all eSIM profiles
   * @returns {Promise<Array>} Array of paths to the generated QR codes
   */
  async generateAllQRCodes() {
    const profiles = this.loadAllProfiles();
    const results = [];
    
    for (const profile of profiles) {
      try {
        const outputPath = path.join(this.outputPath, `esim_${profile.iccid}_${profile.msisdn}.png`);
        const activationCode = this.generateActivationCode(profile);
        await this.generateQRCode(activationCode, outputPath);
        results.push({
          iccid: profile.iccid,
          msisdn: profile.msisdn,
          path: outputPath,
          success: true
        });
      } catch (err) {
        results.push({
          iccid: profile.iccid,
          msisdn: profile.msisdn,
          success: false,
          error: err.message
        });
      }
    }
    
    return results;
  }

  /**
   * Generate an HTML page with all eSIM QR codes
   * @returns {Promise<string|null>} The path to the generated HTML file or null if failed
   */
  async generateHtmlPage() {
    const profiles = this.loadAllProfiles();
    const results = [];
    
    // First generate all QR codes
    for (const profile of profiles) {
      try {
        const outputPath = path.join(this.outputPath, `esim_${profile.iccid}_${profile.msisdn}.png`);
        const activationCode = this.generateActivationCode(profile);
        await this.generateQRCode(activationCode, outputPath);
        results.push({
          profile,
          qrPath: path.basename(outputPath),
          success: true
        });
      } catch (err) {
        results.push({
          profile,
          success: false,
          error: err.message
        });
      }
    }
    
    // Then generate HTML page
    const htmlPath = path.join(this.outputPath, 'esim_qrcodes.html');
    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>eSIM QR Codes</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    h1 {
      text-align: center;
      color: #333;
    }
    .esim-cards {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 20px;
    }
    .esim-card {
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 15px;
      width: 300px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.1);
      text-align: center;
    }
    .esim-card h2 {
      margin-top: 0;
      color: #444;
    }
    .esim-card img {
      max-width: 200px;
      margin: 10px 0;
    }
    .esim-details {
      text-align: left;
      margin-top: 15px;
    }
    .esim-details p {
      margin: 5px 0;
      font-size: 14px;
    }
    .esim-details strong {
      display: inline-block;
      width: 80px;
    }
    .generated-at {
      text-align: center;
      margin-top: 30px;
      color: #666;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <h1>eSIM QR Codes</h1>
  <div class="esim-cards">
    ${results.filter(r => r.success).map(result => `
    <div class="esim-card">
      <h2>Phone: ${result.profile.msisdn}</h2>
      <img src="${result.qrPath}" alt="eSIM QR Code">
      <div class="esim-details">
        <p><strong>ICCID:</strong> ${result.profile.iccid}</p>
        <p><strong>IMSI:</strong> ${result.profile.imsi}</p>
        <p><strong>Status:</strong> ${result.profile.status}</p>
        <p><strong>Created:</strong> ${new Date(result.profile.createdAt).toLocaleString()}</p>
      </div>
    </div>
    `).join('')}
  </div>
  <p class="generated-at">Generated on ${new Date().toLocaleString()}</p>
</body>
</html>
    `;
    
    try {
      fs.writeFileSync(htmlPath, htmlContent);
      console.log(`HTML page generated successfully: ${htmlPath}`);
      return htmlPath;
    } catch (err) {
      console.error('Error generating HTML page:', err);
      return null;
    }
  }
}

// Export the class
module.exports = ESIMQRCodeGenerator;

// If run directly as a script
if (require.main === module) {
  // Check if required package is installed
  try {
    require.resolve('qrcode');
  } catch (e) {
    console.error('Error: qrcode package is not installed. Please run: npm install qrcode');
    process.exit(1);
  }

  // Parse command line arguments
  const args = process.argv.slice(2);
  
  // Default configuration
  const config = {
    smDpPlusAddress: process.env.SM_DP_PLUS_ADDRESS || '0.0.0.0',
    dataPath: path.join(__dirname, CONFIG.DATA_DIR, 'esims'),
    outputPath: path.join(__dirname, CONFIG.OUTPUT_DIR)
  };
  
  // Process command line arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sm-dp-address' && i + 1 < args.length) {
      config.smDpPlusAddress = args[i + 1];
      i++;
    } else if (args[i] === '--data-path' && i + 1 < args.length) {
      config.dataPath = args[i + 1];
      i++;
    } else if (args[i] === '--output-path' && i + 1 < args.length) {
      config.outputPath = args[i + 1];
      i++;
    }
  }
  
  // Create the generator
  const generator = new ESIMQRCodeGenerator(config);
  
  // Generate HTML page with all QR codes
  generator.generateHtmlPage()
    .then(htmlPath => {
      if (htmlPath) {
        console.log(`HTML page with all eSIM QR codes generated: ${htmlPath}`);
      } else {
        console.error('Failed to generate HTML page');
      }
    })
    .catch(err => {
      console.error('Error:', err);
    });
}