// Import library
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
// Rute khusus untuk melayani file index.html secara manual
// app.get('/', (req, res) => {
//     res.sendFile(path.join(__dirname, 'index.html'));
// });

// Mengarahkan ke file index.html yang ada di dalam folder public
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public','index.html'));
});

app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

let sock;
let db;

// Fungsi untuk menghubungkan ke database MySQL
const connectToDatabase = async () => {
    db = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });
    console.log('✅ Terhubung ke database MySQL');
};

// Fungsi memuat balasan otomatis dari database
const loadAutoReplies = async () => {
    const [rows] = await db.execute('SELECT * FROM auto_replies');
    const autoReplies = {};
    rows.forEach(row => {
        autoReplies[row.keyword] = JSON.parse(row.replies);
    });
    return autoReplies;
};

// Inisialisasi koneksi ke WhatsApp
const authPath = path.resolve(__dirname, './auth');
if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        sock = makeWASocket({ auth: state });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📷 QR Code diperbarui, tampilkan di browser...');
                const qrCodeUrl = await qrcode.toDataURL(qr);
                fs.writeFileSync('./auth/qr.html', `<img src="${qrCodeUrl}" alt="QR Code" />`);
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('❌ Koneksi terputus, mencoba menghubungkan ulang...', shouldReconnect);
                if (shouldReconnect) connectToWhatsApp();
            } else if (connection === 'open') {
                console.log('✅ WhatsApp berhasil terhubung!');
                if (fs.existsSync('./auth/qr.html')) fs.unlinkSync('./auth/qr.html');
            }
        });

        
        

	// Fungsi delay
	const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    // End fungsi delay

    // Event untuk mendengarkan pembaruan kontak
    sock.ev.on('contacts.update', (contacts) => {
        console.log('🔄 Kontak diperbarui:', contacts);
        // Pastikan kita bisa mengakses kontak baru di sini
       });
    // End event

        sock.ev.on('messages.upsert', async ({ messages }) => {
            console.log('📩 Pesan diterima:', JSON.stringify(messages, null, 2)); // Debug pesan masuk

            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) {
                console.log('❌ Pesan kosong atau dikirim oleh diri sendiri.');
                return;
            }

            // Ambil isi pesan dari berbagai kemungkinan format
            const messageContent = msg.message.conversation 
                || msg.message.extendedTextMessage?.text 
                || msg.message.imageMessage?.caption 
                || msg.message.videoMessage?.caption 
                || msg.message.stickerMessage?.fileSha256 
                || msg.message.audioMessage?.ptt 
                || msg.message.buttonsResponseMessage?.selectedButtonId 
                || msg.message.listResponseMessage?.title 
                || 'Pesan tidak didukung';
            
            console.log('📥 Isi pesan yang dikenali:', messageContent);

            // Ambil nama profil pengirim
            const senderJid = msg.key.remoteJid;
            const contact = sock.store?.contacts[senderJid] || {};
            const senderName = contact.name || contact.notify || msg.pushName || 'pengguna';

            console.log(`👤 Nama pengirim: ${senderName}`);

            const autoReplies = await loadAutoReplies();
            for (const keyword in autoReplies) {
                if (messageContent.trim().toLowerCase() === keyword.toLowerCase()) {
                    const replies = autoReplies[keyword];
                    for (const reply of replies) {
                        const personalizedReply = reply.replace('{name}', senderName); // Ganti placeholder {name} dengan nama pengirim
                        await delay(5000); // Atur delay
                        await sendMessage(senderJid, personalizedReply);
                    }
                    break;
                }
            }
        });

    
    } catch (error) {
        console.error('❌ Terjadi kesalahan saat menghubungkan ke WhatsApp:', error.message);
        setTimeout(connectToWhatsApp, 5000);
    }
}

const sendMessage = async (number, message) => {
    try {
        await sock.sendMessage(number, { text: message });
        console.log('✅ Pesan terkirim ke', number);
    } catch (error) {
        console.error('❌ Gagal mengirim pesan:', error);
    }
};


// API untuk menampilkan QR Code
app.get('/scan', (req, res) => {
    const qrFilePath = path.resolve(__dirname, './auth/qr.html');
    if (fs.existsSync(qrFilePath)) {
        res.sendFile(qrFilePath);
    } else {
        res.send('<h1>QR Code tidak tersedia, WhatsApp sudah terhubung atau sedang memuat...</h1>');
    }
});
// End


// API untuk mengirim pesan
app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) {
        return res.status(400).json({ status: 'error', message: 'Nomor dan pesan diperlukan' });
    }

    try {
        await sendMessage(number + '@s.whatsapp.net', message);
        res.status(200).json({ status: 'success', message: 'Pesan berhasil dikirim' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Gagal mengirim pesan', error });
    }
});
// End


// API untuk mengatur balasan otomatis
app.post('/set-auto-reply', async (req, res) => {
    const { keyword, replies } = req.body;
    if (!keyword || !Array.isArray(replies)) {
        return res.status(400).json({ status: 'error', message: 'Keyword dan balasan diperlukan' });
    }

    try {
        await db.execute('INSERT INTO auto_replies (keyword, replies) VALUES (?, ?) ON DUPLICATE KEY UPDATE replies = ?', [keyword, JSON.stringify(replies), JSON.stringify(replies)]);
        res.status(200).json({ status: 'success', message: 'Balasan otomatis berhasil diperbarui' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Gagal menyimpan balasan otomatis' });
    }
});
// End

// API untuk Cek status koneksi Whatsapp
app.get('/status', (req, res) => {
    res.json({ status: sock ? 'connected' : 'disconnected' });
});
// End

// API untuk logout dari Whatsapp
app.get('/logout', async (req, res) => {
    try {
        await sock.logout();
        res.json({ status: 'success', message: 'Berhasil logout' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Gagal logout', error });
    }
});
// End

// API untuk mendapatkan daftar grup dan ID grup
app.get('/groups', async (req, res) => {
    try {
        const groups = [];
        const chats = await sock.groupFetchAllParticipating();
        for (const id in chats) {
            const group = chats[id];
            groups.push({ name: group.subject, id: group.id });
        }
        res.status(200).json({ status: 'success', groups });
    } catch (error) {
        console.error('❌ Gagal mendapatkan daftar grup:', error);
        res.status(500).json({ status: 'error', message: 'Gagal mendapatkan daftar grup', error });
    }
});
// End

// API untuk mengirim pesan ke grup
app.post('/send-group-message', async (req, res) => {
    const { groupId, message } = req.body;

    if (!groupId || !message) {
        return res.status(400).json({ status: 'error', message: 'ID grup dan pesan diperlukan' });
    }

    try {
        await sock.sendMessage(groupId, { text: message });
        console.log('✅ Pesan terkirim ke grup', groupId);
        res.status(200).json({ status: 'success', message: 'Pesan berhasil dikirim ke grup' });
    } catch (error) {
        console.error('❌ Gagal mengirim pesan ke grup:', error);
        res.status(500).json({ status: 'error', message: 'Gagal mengirim pesan ke grup', error });
    }
});
// End

// API untuk mengambil daftar auto-reply
app.get('/auto-replies', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM auto_replies');
        const autoReplies = rows.map(row => ({
            keyword: row.keyword,
            replies: JSON.parse(row.replies),
        }));
        res.json({ status: 'success', replies: autoReplies });
    } catch (error) {
        console.error('❌ Gagal mengambil auto-reply:', error);
        res.status(500).json({ status: 'error', message: 'Gagal mengambil data auto-reply' });
    }
});
// End


// API untuk menghapus auto-reply berdasarkan keyword
app.delete('/auto-reply/:keyword', async (req, res) => {
    const { keyword } = req.params;

    if (!keyword) {
        return res.status(400).json({ status: 'error', message: 'Keyword diperlukan' });
    }

    try {
        // Hapus data auto-reply berdasarkan keyword
        const [result] = await db.execute('DELETE FROM auto_replies WHERE keyword = ?', [keyword]);

        if (result.affectedRows > 0) {
            res.status(200).json({ status: 'success', message: `Auto-reply dengan keyword "${keyword}" berhasil dihapus` });
        } else {
            res.status(404).json({ status: 'error', message: `Auto-reply dengan keyword "${keyword}" tidak ditemukan` });
        }
    } catch (error) {
        console.error('❌ Gagal menghapus auto-reply:', error);
        res.status(500).json({ status: 'error', message: 'Gagal menghapus auto-reply' });
    }
});
// End


// Jalankan server
app.listen(port, async () => {
    await connectToDatabase();
    console.log(`🚀 Server berjalan di http://localhost:${port}`);
    connectToWhatsApp();
});
