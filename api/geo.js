const axios = require('axios');
const sharp = require('sharp');
const StaticMaps = require('staticmaps');
const NodeGeocoder = require('node-geocoder');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');

const TOKEN = process.env.TOKEN_GEO;
const API_URL = `https://api.telegram.org/bot${TOKEN}`;
const geocoder = NodeGeocoder({ provider: 'openstreetmap' });

// State sederhana untuk menyimpan alur percakapan user
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
            await sendMsg(chatId, "📍 Silakan kirim **Share Location** Anda atau ketik **Koordinat** (lat, lon).");
        } 
        else if (state.step === 'GET_LOCATION') {
            await handleLocation(chatId, message);
        }
        else if (state.step === 'GET_DATETIME') {
            userState[chatId].waktu = text;
            userState[chatId].step = 'GET_PHOTO';
            userState[chatId].photos = [];
            await sendMsg(chatId, "📸 Kirim **FOTO** Anda. Jika sudah semua, ketik **SELESAI**.");
        }
        else if (state.step === 'GET_PHOTO') {
            if (text?.toUpperCase() === 'SELESAI') {
                await sendMsg(chatId, "✅ Semua foto telah diproses. Gunakan /start untuk memulai lagi.");
                delete userState[chatId];
            } else if (message.photo) {
                await processImage(chatId, message.photo);
            }
        }
    } catch (e) {
        console.error("Main Error:", e);
    }
    return res.status(200).send('ok');
};

async function handleLocation(chatId, message) {
    let lat, lon;
    if (message.location) {
        lat = message.location.latitude;
        lon = message.location.longitude;
    } else if (message.text) {
        const match = message.text.match(/[-+]?\d*\.\d+|\d+/g);
        if (match && match.length >= 2) {
            lat = parseFloat(match[0]);
            lon = parseFloat(match[1]);
        }
    }

    if (lat && lon) {
        try {
            const geoRes = await geocoder.reverse({ lat, lon });
            const addr = geoRes[0];
            userState[chatId] = {
                step: 'GET_DATETIME',
                lat, lon,
                alamat: addr.formattedAddress || "Alamat tidak ditemukan",
                kec: addr.subdistrict || addr.city || "-",
                prov: addr.state || "-"
            };
            await sendMsg(chatId, `📍 Lokasi: ${userState[chatId].kec}\n\nSekarang ketik **Tanggal & Jam** (Contoh: 27/03/2026 14:00).`);
        } catch (err) {
            await sendMsg(chatId, "⚠️ Gagal mengambil alamat. Silakan coba lagi.");
        }
    } else {
        await sendMsg(chatId, "❌ Format salah. Kirim Share Location atau ketik koordinat.");
    }
}

async function processImage(chatId, photoArray) {
    try {
        const data = userState[chatId];
        const fileId = photoArray[photoArray.length - 1].file_id;
        
        // 1. Download Foto dari Telegram
        const fileInfo = await axios.get(`${API_URL}/getFile?file_id=${fileId}`);
        const imgPath = fileInfo.data.result.file_path;
        const imgDownload = await axios.get(`https://api.telegram.org/file/bot${TOKEN}/${imgPath}`, { responseType: 'arraybuffer' });
        const imgBuffer = Buffer.from(imgDownload.data);

        // 2. Render Peta Statis
        const map = new StaticMaps({ width: 600, height: 600 });
        const pinPath = path.join(process.cwd(), 'assets', 'pin.png');
        
        if (fs.existsSync(pinPath)) {
            map.addMarker({ coords: [data.lon, data.lat], img: pinPath, width: 48, height: 48 });
        } else {
            map.addMarker({ coords: [data.lon, data.lat], color: '#FF0000', size: 20 });
        }

        await map.render();
        const mapBuffer = await map.image.save(null, { compressionLevel: 9 });

        // 3. Gabungkan Gambar, Peta, dan Teks dengan Sharp
        const meta = await sharp(imgBuffer).metadata();
        const infoH = Math.max(Math.round(meta.width * 0.25), 320);
        
        // Buat Overlay Teks (SVG)
        const svgTeks = `
            <svg width="${meta.width}" height="${infoH}">
                <style>
                    .t { fill: white; font-family: sans-serif; text-anchor: end; }
                    .addr { font-size: ${Math.round(meta.width * 0.022)}px; }
                    .bold { font-size: ${Math.round(meta.width * 0.032)}px; font-weight: bold; }
                </style>
                <text x="${meta.width - 30}" y="60" class="t addr">${data.alamat.substring(0, 80)}</text>
                <text x="${meta.width - 30}" y="130" class="t bold">Kecamatan ${data.kec}</text>
                <text x="${meta.width - 30}" y="190" class="t bold">${data.prov}</text>
                <text x="${meta.width - 30}" y="250" class="t bold">${data.waktu}</text>
            </svg>`;

        const result = await sharp({
            create: {
                width: meta.width,
                height: meta.height + infoH,
                channels: 3,
                background: { r: 15, g: 15, b: 15 }
            }
        })
        .composite([
            { input: imgBuffer, top: 0, left: 0 },
            { input: await sharp(mapBuffer).resize(infoH - 60, infoH - 60).toBuffer(), top: meta.height + 30, left: 30 },
            { input: Buffer.from(svgTeks), top: meta.height, left: 0 }
        ])
        .jpeg({ quality: 90 })
        .toBuffer();

        // 4. Kirim Kembali ke User
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('photo', result, { filename: 'geotag.jpg' });
        
        await axios.post(`${API_URL}/sendPhoto`, form, { headers: form.getHeaders() });

    } catch (err) {
        console.error("Processing Error:", err);
        await sendMsg(chatId, "❌ Gagal memproses gambar: " + err.message);
    }
}

async function sendMsg(chatId, text) {
    await axios.post(`${API_URL}/sendMessage`, { chat_id: chatId, text, parse_mode: 'Markdown' });
}