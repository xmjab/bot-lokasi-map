const axios = require('axios');
const sharp = require('sharp');
const StaticMaps = require('node-staticmaps');
const NodeGeocoder = require('node-geocoder');
const FormData = require('form-data');
const path = require('path');

const TOKEN = process.env.TOKEN_GEO;
const API_URL = `https://api.telegram.org/bot${TOKEN}`;
const geocoder = NodeGeocoder({ provider: 'openstreetmap' });

// Penyimpanan State Sederhana (In-Memory)
// Catatan: Vercel serverless akan mereset ini berkala, 
// tapi cukup untuk alur singkat satu user.
let userState = {};

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(200).send('Geo Bot Active');

    const { message } = req.body;
    if (!message) return res.status(200).send('ok');

    const chatId = message.chat.id;
    const text = message.text;
    const state = userState[chatId] || { step: 'START' };

    try {
        if (text === '/start') {
            userState[chatId] = { step: 'GET_LOCATION' };
            await sendMsg(chatId, "📍 Silakan kirim **Share Location** atau ketik **Koordinat** (lat, lon).");
        } 
        else if (state.step === 'GET_LOCATION') {
            await handleLocation(chatId, message);
        }
        else if (state.step === 'GET_DATETIME') {
            userState[chatId].waktu = text;
            userState[chatId].step = 'GET_PHOTO';
            await sendMsg(chatId, "📸 Kirim **FOTO** Anda, lalu ketik **SELESAI**.");
        }
        else if (state.step === 'GET_PHOTO') {
            if (text?.toUpperCase() === 'SELESAI') {
                await sendMsg(chatId, "✅ Proses selesai. Kembali ke /start untuk data baru.");
                delete userState[chatId];
            } else if (message.photo) {
                await processImage(chatId, message.photo);
            }
        }
    } catch (e) {
        console.error(e);
    }
    return res.status(200).send('ok');
};

async function handleLocation(chatId, message) {
    let lat, lon;
    if (message.location) {
        lat = message.location.latitude;
        lon = message.location.longitude;
    } else {
        const match = message.text.match(/[-+]?\d*\.\d+|\d+/g);
        if (match && match.length >= 2) {
            lat = parseFloat(match[0]);
            lon = parseFloat(match[1]);
        }
    }

    if (lat && lon) {
        const res = await geocoder.reverse({ lat, lon });
        const addr = res[0];
        userState[chatId] = {
            step: 'GET_DATETIME',
            lat, lon,
            alamat: addr.formattedAddress,
            kec: addr.subdistrict || addr.city || "-",
            prov: addr.state || "-"
        };
        await sendMsg(chatId, `📍 Lokasi diterima: ${addr.subdistrict || ''}\n\nSekarang ketik **Tanggal & Jam**.`);
    } else {
        await sendMsg(chatId, "❌ Format salah. Kirim lokasi atau koordinat.");
    }
}

async function processImage(chatId, photos) {
    const data = userState[chatId];
    const fileId = photos[photos.length - 1].file_id;
    
    // 1. Download Foto
    const fileRes = await axios.get(`${API_URL}/getFile?file_id=${fileId}`);
    const filePath = fileRes.data.result.file_path;
    const imgRes = await axios.get(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`, { responseType: 'arraybuffer' });
    const imgBuffer = Buffer.from(imgRes.data);

    // 2. Generate Map
    const map = new StaticMaps({ width: 400, height: 400 });
    map.addMarker({ coords: [data.lon, data.lat], img: path.join(process.cwd(), 'assets', 'pin.png'), width: 32, height: 32 });
    const mapBuffer = await map.render();

    // 3. Gabungkan dengan Sharp
    const metadata = await sharp(imgBuffer).metadata();
    const infoHeight = Math.max(Math.round(metadata.width * 0.25), 300);
    
    const canvas = sharp({
        create: {
            width: metadata.width,
            height: metadata.height + infoHeight,
            channels: 3,
            background: { r: 15, g: 15, b: 15 }
        }
    });

    const finalBuffer = await canvas
        .composite([
            { input: imgBuffer, top: 0, left: 0 },
            { input: await sharp(mapBuffer).resize(infoHeight - 40).toBuffer(), top: metadata.height + 20, left: 20 },
            // Untuk teks, kita gunakan SVG karena Node.js tidak bisa langsung draw text tanpa library berat
            { 
                input: Buffer.from(`
                    <svg width="${metadata.width}" height="${infoHeight}">
                        <style>
                            .text { fill: white; font-family: Arial; font-weight: bold; }
                            .addr { font-size: ${Math.round(metadata.width * 0.02)}px; }
                            .detail { font-size: ${Math.round(metadata.width * 0.03)}px; }
                        </style>
                        <text x="${metadata.width - 20}" y="40" text-anchor="end" class="text addr">${data.alamat.substring(0, 60)}...</text>
                        <text x="${metadata.width - 20}" y="100" text-anchor="end" class="text detail">Kecamatan ${data.kec}</text>
                        <text x="${metadata.width - 20}" y="150" text-anchor="end" class="text detail">${data.prov}</text>
                        <text x="${metadata.width - 20}" y="200" text-anchor="end" class="text detail">${data.waktu}</text>
                    </svg>
                `), 
                top: metadata.height + 20, 
                left: 0 
            }
        ])
        .jpeg()
        .toBuffer();

    // 4. Kirim ke Telegram
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('photo', finalBuffer, { filename: 'watermark.jpg' });
    await axios.post(`${API_URL}/sendPhoto`, form, { headers: form.getHeaders() });
}

async function sendMsg(chatId, text) {
    await axios.post(`${API_URL}/sendMessage`, { chat_id: chatId, text, parse_mode: 'Markdown' });
}