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
const FILE_ID = '1txoH16hqTCBIiWPYofRWrPzNvzUP1SzY';
const MANAOFC_PATH = path.join(__dirname, 'manaofc.js');

// ===== Download manaofc.js safely =====
async function downloadManaofc() {
    if (fs.existsSync(MANAOFC_PATH)) {
        console.log('✔ manaofc.js already exists');
        return;
    }

    const url = `https://drive.google.com/uc?id=${FILE_ID}&export=download`;
    console.log('⬇ Downloading manaofc.js...');

    const response = await axios.get(url, {
        responseType: 'text',
        maxBodyLength: Infinity
    });

    // ❌ Google Drive HTML page protection
    if (response.data.trim().startsWith('<')) {
        throw new Error(
            'Downloaded file is HTML, not JavaScript. ' +
            'Make sure Google Drive file is PUBLIC (Anyone with link → Viewer)'
        );
    }

    fs.writeFileSync(MANAOFC_PATH, response.data);
    console.log('✔ manaofc.js downloaded successfully');
}

// ===== Start Server =====
async function start() {
    try {
        await downloadManaofc();

        // Require AFTER correct download
        const code = require('./manaofc');

        // If exported function, run it
        if (typeof code === 'function') {
            code(app);
        }

        // If exported router
        if (typeof code === 'object') {
            app.use('/code', code);
        }

        // Routes
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
        console.error('❌ Failed to start server:\n', err.message);
        process.exit(1);
    }
}

start();

module.exports = app;
