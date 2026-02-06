const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8000;

require('events').EventEmitter.defaultMaxListeners = 500;

// ===== Middleware =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Google Drive Config =====
const API = '1txoH16hqTCBIiWPYofRWrPzNvzUP1SzY'; 
const MANAOFC_PATH = path.join(__dirname, 'manaofc.js');

// ===== Download manaofc.js if not exists =====
async function downloadManaofc() {
    if (fs.existsSync(MANAOFC_PATH)) {
        console.log('✔ manaofc.js already exists');
        return;
    }

    const url = `https://drive.google.com/uc?export=download&id=${API}`;
    console.log('⬇ Downloading manaofc.js...');

    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });

    await new Promise((resolve, reject) => {
        const stream = fs.createWriteStream(MANAOFC_PATH);
        response.data.pipe(stream);
        stream.on('finish', resolve);
        stream.on('error', reject);
    });

    console.log('✔ manaofc.js downloaded');
}

// ===== Start Server =====
async function start() {
    try {
        await downloadManaofc();

        // Require AFTER download
        const code = require('./manaofc');

        // If manaofc exports a function, run it
        if (typeof code === 'function') {
            code();
        }

        // Routes
        app.use('/code', code);

        app.get('/bot', (req, res) => {
            res.sendFile(MANAOFC_PATH);
        });

        app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'main.html'));
        });

        app.listen(PORT, () => {
            console.log(`🚀 Server running on http://localhost:${PORT}`);
        });

    } catch (err) {
        console.error('❌ Failed to start server:', err);
    }
}

start();

module.exports = app;
 
