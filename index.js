const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8000;

// ===== Middleware =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Function to download JS from GitHub =====
async function downloadJSFile(url, outputPath) {
    try {
        const response = await axios.get(url);
        fs.writeFileSync(outputPath, response.data, 'utf8');
        console.log('File downloaded successfully!');
    } catch (err) {
        console.error('Error downloading file:', err);
    }
}

// ===== Auto-download the file at server start =====
const githubURL = 'https://raw.githubusercontent.com/manaofc/file/main/manaofc.js';
const localPath = path.join(__dirname, 'manaofc.js');

(async () => {
    await downloadJSFile(githubURL, localPath);

    // Now we can require the file like a normal module
    const code = require(localPath);

    // ===== Routes =====
    app.use('/code', code);

    app.get('/bot', (req, res) => {
        res.sendFile(localPath); // serve the JS file
    });

    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'main.html'));
    });

    // ===== Server =====
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
})();
