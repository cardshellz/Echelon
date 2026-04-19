const fs = require('fs');

if (fs.existsSync('.env')) {
  const lines = fs.readFileSync('.env', 'utf8').split('\n');
  for (const line of lines) {
    if (line && !line.startsWith('#') && line.includes('=')) {
      const [k, ...v] = line.split('=');
      process.env[k.trim()] = v.join('=').trim();
    }
  }
}

// Ensure SSL is forced 
process.env.EXTERNAL_DATABASE_URL = process.env.DATABASE_URL;
process.env.NODE_ENV = 'production';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
