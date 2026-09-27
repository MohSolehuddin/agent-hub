const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());

// Tentukan direktori spesifik project yang akan dikerjakan
const TARGET_PROJECT_DIR = path.join(os.homedir(), 'project/have-fun/personal-tools');

app.post('/api/run-task', (req, res) => {
    const { task } = req.body;
    
    if (!task) {
        return res.status(400).json({ error: "Properti 'task' wajib diisi di body request JSON." });
    }

    console.log(`\n[+] Menerima tugas baru dari server: "${task}"`);
    console.log(`[+] Menjalankan agy di direktori target: ${TARGET_PROJECT_DIR}`);

    // Command agy:
    // -p: Berjalan satu kali tanpa masuk ke UI interaktif (Print mode)
    // --dangerously-skip-permissions: PENTING! Agar agent otomatis menyetujui izin modifikasi file / eksekusi tanpa menunggu Anda mengetik 'Y'
    const agyCommand = `agy -p "${task}" --dangerously-skip-permissions`;

    // Berikan respons secepatnya agar server yang mengirim request tidak timeout (karena AI bisa berpikir agak lama)
    res.json({ 
        status: "accepted", 
        message: "Tugas sedang diproses oleh Antigravity di background.",
        target_dir: TARGET_PROJECT_DIR
    });

    // Jalankan agy di background menggunakan cwd (Current Working Directory) yang spesifik
    exec(agyCommand, { cwd: TARGET_PROJECT_DIR, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        console.log(`\n========= HASIL TUGAS =========`);
        console.log(`Tugas: ${task}`);
        if (error) {
            console.error(`[!] Error: ${error.message}`);
        }
        if (stderr) {
            console.error(`[!] STDERR: ${stderr}`);
        }
        console.log(`[>] STDOUT:\n${stdout}`);
        console.log(`===============================\n`);
        
        // TODO: Anda bisa menambahkan kode HTTP POST (axios/fetch) di sini 
        // untuk mengirim hasilnya (stdout) kembali ke Aplikasi Server Utama Anda.
    });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🤖 Antigravity Client Listener aktif dan berjalan di http://localhost:${PORT}`);
    console.log(`Menunggu perintah POST di endpoint /api/run-task...`);
});
