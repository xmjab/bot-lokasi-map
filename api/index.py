import os
import re
import asyncio
import json
from io import BytesIO
from telegram import Update, ReplyKeyboardMarkup, ReplyKeyboardRemove
from telegram.ext import ApplicationBuilder, ContextTypes, MessageHandler, filters, CommandHandler, ConversationHandler
from PIL import Image, ImageDraw, ImageFont
from geopy.geocoders import Nominatim
from staticmap import StaticMap, CircleMarker

# Konfigurasi Path
FONT_FILE = os.path.join(os.getcwd(), 'assets', 'calibri-bold.ttf')
TOKEN = os.getenv("TOKEN_GEO") # Gunakan Env Var berbeda

geolocator = Nominatim(user_agent="geo_bot_vercel")
GET_LOCATION, GET_DATETIME, GET_PHOTO = range(3)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Silahkan kirim **Share Location** Anda atau ketik **Titik Koordinat** manual.",
        parse_mode='Markdown'
    )
    return GET_LOCATION

async def handle_location(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.location:
        lat, lon = update.message.location.latitude, update.message.location.longitude
    else:
        try:
            coords = re.findall(r"[-+]?\d*\.\d+|\d+", update.message.text)
            lat, lon = float(coords[0]), float(coords[1])
        except:
            await update.message.reply_text("Format salah. Kirim lokasi atau ketik: lat, lon")
            return GET_LOCATION

    try:
        location = geolocator.reverse(f"{lat}, {lon}", timeout=10)
        address = location.raw.get('address', {})
        context.user_data['geo'] = {
            "lat": lat, "lon": lon,
            "alamat": location.address,
            "kec": address.get('subdistrict') or address.get('village') or address.get('town') or "-",
            "prov": address.get('state', "-")
        }
        await update.message.reply_text("Sekarang ketik **Tanggal & Jam**.")
        return GET_DATETIME
    except:
        await update.message.reply_text("Gagal mengambil alamat. Coba lagi.")
        return GET_LOCATION

async def handle_datetime(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data['geo']['waktu'] = update.message.text
    context.user_data['photos'] = []
    markup = ReplyKeyboardMarkup([['SELESAI']], one_time_keyboard=True, resize_keyboard=True)
    await update.message.reply_text("Kirim **FOTO**, lalu klik **SELESAI**.", reply_markup=markup)
    return GET_PHOTO

async def process_multiple_images(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message.photo:
        context.user_data['photos'].append(update.message.photo[-1].file_id)
        await update.message.reply_text(f"Foto ke-{len(context.user_data['photos'])} diterima.")
        return GET_PHOTO

    if update.message.text and update.message.text.upper() == "SELESAI":
        data = context.user_data.get('geo')
        for photo_id in context.user_data.get('photos', []):
            # Download ke memory (BytesIO) bukan Drive
            file = await context.bot.get_file(photo_id)
            photo_bytes = await file.download_as_bytearray()
            
            img = Image.open(BytesIO(photo_bytes)).convert('RGB')
            w, h = img.size
            info_h = max(int(w * 0.22), 300)

            new_img = Image.new('RGB', (w, h + info_h), color=(15, 15, 15))
            new_img.paste(img, (0, 0))
            draw = ImageDraw.Draw(new_img)

            # MAPS
            map_dim = int(info_h * 0.85)
            m = StaticMap(600, 600)
            m.add_marker(CircleMarker((data['lon'], data['lat']), 'red', 18))
            map_img = m.render().convert('RGBA').resize((map_dim, map_dim), Image.LANCZOS)
            margin = (info_h - map_dim) // 2
            new_img.paste(map_img, (margin, h + margin), map_img)

            # TEXT (Gunakan Font dari assets)
            f_size_addr = int(w * 0.022)
            try:
                font_addr = ImageFont.truetype(FONT_FILE, f_size_addr)
            except:
                font_addr = ImageFont.load_default()

            # (Logika draw.text Anda tetap sama di sini...)
            draw.text((margin + map_dim + 20, h + margin), data['alamat'][:50], font=font_addr, fill="white")

            # Kirim balik
            out_buf = BytesIO()
            new_img.save(out_buf, format='JPEG', quality=90)
            out_buf.seek(0)
            await update.message.reply_photo(photo=out_buf)

        await update.message.reply_text("Selesai!", reply_markup=ReplyKeyboardRemove())
        return ConversationHandler.END

# HANDLER VERCEL
app = ApplicationBuilder().token(TOKEN).build()
conv_handler = ConversationHandler(
    entry_points=[CommandHandler('start', start)],
    states={
        GET_LOCATION: [MessageHandler(filters.LOCATION | (filters.TEXT & ~filters.COMMAND), handle_location)],
        GET_DATETIME: [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_datetime)],
        GET_PHOTO: [
            MessageHandler(filters.PHOTO, process_multiple_images),
            MessageHandler(filters.Regex('^(SELESAI|Selesai|selesai)$'), process_multiple_images)
        ],
    },
    fallbacks=[CommandHandler('cancel', start)],
)
app.add_handler(conv_handler)

async def handler(event, context):
    if event.get("httpMethod") == "POST":
        await app.initialize()
        update = Update.de_json(json.loads(event.get("body")), app.bot)
        await app.process_update(update)
    return {"statusCode": 200, "body": "ok"}