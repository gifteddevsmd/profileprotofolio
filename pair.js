const PastebinAPI = require('pastebin-js');
const pastebin = new PastebinAPI('EMWTMkQAVfJa9kM-MRUrxd5Oku1U7pgL');
const { makeid } = require('./id');
const express = require('express');
const fs = require('fs');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    delay,
    makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const router = express.Router();

// Helper function to remove files
function removeFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath, { recursive: true, force: true });
}

// Cleanup temp files periodically
setInterval(() => {
    const tempDir = './temp';
    if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        const now = Date.now();
        files.forEach(file => {
            const filePath = `${tempDir}/${file}`;
            const stats = fs.statSync(filePath);
            // Delete files older than 1 hour
            if (now - stats.mtimeMs > 60 * 60 * 1000) {
                removeFile(filePath);
            }
        });
    }
}, 30 * 60 * 1000); // Run every 30 minutes

// Route handler
router.get('/', async (req, res) => {
    const id = makeid();
    let num = req.query.number;

    // Validate number
    if (num) {
        num = num.replace(/[^0-9]/g, '');
        if (num.length < 10) {
            return res.status(400).send({ error: 'Invalid phone number' });
        }
    }

    async function RAVEN() {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);
        
        try {
            const client = makeWASocket({
                printQRInTerminal: false,
                version,
                logger: pino({ level: 'silent' }),
                browser: ['Ubuntu', 'Chrome', '20.0.04'],
                auth: state,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 0,
                // Add these for better stability
                keepAliveIntervalMs: 10000,
                emitOwnEvents: true,
                generateHighQualityLinkPreview: true,
            });

            client.ev.on('creds.update', saveCreds);
            
            client.ev.on('connection.update', async (s) => {
                const { connection, lastDisconnect, qr } = s;
                
                // Send QR code if available
                if (qr && !res.headersSent) {
                    return res.send({ qr: qr });
                }

                if (connection === 'open') {
                    await client.sendMessage(client.user.id, { 
                        text: `Generating your session_id, Wait . .` 
                    });
                    
                    await delay(3000);

                    try {
                        const data = fs.readFileSync(__dirname + `/temp/${id}/creds.json`);
                        const b64data = Buffer.from(data).toString('base64');
                        const session = await client.sendMessage(client.user.id, { 
                            text: 'dave~' + b64data 
                        });

                        // Send success message
                        await client.sendMessage(client.user.id, {
                            text: `
╔════════════════════
║ ◇ SESSION CONNECTED ◇
╚════════════════════
📱 Number: ${client.user.id.split(':')[0]}
🆔 Session ID: ${id}
⏰ Generated: ${new Date().toLocaleString()}

✅ Session generated successfully!
Use this in your main bot.`
                        }, { quoted: session });

                        await delay(1000);
                        await client.ws.close();
                        
                        // Cleanup after successful generation
                        setTimeout(() => {
                            removeFile('./temp/' + id);
                        }, 5000);
                        
                    } catch (fileErr) {
                        console.log('File read error:', fileErr);
                        await client.sendMessage(client.user.id, { 
                            text: '❌ Error generating session file' 
                        });
                    }
                    
                } else if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    if (statusCode === 401) {
                        // Logged out - need new QR
                        if (!res.headersSent) {
                            res.send({ error: 'Session expired, please refresh' });
                        }
                    } else if (statusCode !== 401) {
                        // Temporary disconnect - try to reconnect
                        await delay(5000);
                        RAVEN();
                    }
                    
                    // Cleanup on close
                    setTimeout(() => {
                        removeFile('./temp/' + id);
                    }, 10000);
                }
            });

            // Handle pairing code if number provided
            if (num && !client.authState.creds.registered) {
                await delay(2000);
                try {
                    const code = await client.requestPairingCode(num);
                    if (!res.headersSent) {
                        res.send({ code: code });
                    }
                } catch (pairErr) {
                    console.log('Pairing error:', pairErr);
                    if (!res.headersSent) {
                        res.send({ error: 'Failed to get pairing code' });
                    }
                }
            }

        } catch (err) {
            console.log('Session generator error:', err);
            removeFile('./temp/' + id);
            if (!res.headersSent) {
                res.status(500).send({ 
                    error: 'Service Currently Unavailable',
                    details: err.message 
                });
            }
        }
    }

    await RAVEN();
});

module.exports = router;