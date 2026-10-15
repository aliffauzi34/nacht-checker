# Nacht Checker

App Next.js (App Router, TypeScript) untuk:

1. **Cek** file video: VBR / CBR, dan berapa bitrate-nya (grafik bitrate per detik per file).
2. **Ubah ke CBR secara masal** dengan bitrate bebas yang kamu input.

## Persiapan

Butuh **ffmpeg + ffprobe** terinstall (dengan libx264) dan Node.js 18.18+.

```bash
# Ubuntu/Debian
sudo apt install ffmpeg
# Windows: download dari ffmpeg.org lalu tambahkan ke PATH
#   atau set FFMPEG_PATH / FFPROBE_PATH di .env.local
```

## Jalankan

```bash
npm install
npm run dev        # http://localhost:3000
# produksi:
npm run build && npm start
```

## Cara pakai

1. Isi path folder (atau satu file) di server tempat app ini jalan, klik **Cek video**.
2. Lihat tipe, bitrate video/audio, dan sparkline per file.
3. Centang file (atau klik **Pilih yang bukan CBR**), isi **Bitrate video CBR (kbps)**, klik **Ubah ... ke CBR**.
4. Hasil disimpan di `cbr_output/` di sebelah file asli (atau folder output pilihanmu). File asli tidak disentuh.

## Cara deteksi

Bitrate video dihitung per detik dari ukuran packet (ffprobe) pada 120 detik pertama.
Lalu dihitung variasinya (standar deviasi / rata-rata):

| Variasi | Hasil |
|---|---|
| ≤ 8% | CBR |
| 8% – 20% | Mendekati CBR (misalnya VBR dengan batas maxrate) |
| > 20% | VBR |

Ini heuristik: file dengan adegan statis atau bitrate sangat rendah bisa terbaca beda dari header-nya.

## Perintah ffmpeg yang dipakai

```
-c:v libx264 -b:v Xk -minrate Xk -maxrate Xk -bufsize 2Xk -x264-params nal-hrd=cbr:force-cfr=1
```

`nal-hrd=cbr` membuat x264 menambah filler data sehingga bitrate benar-benar rata (cocok untuk live streaming/RTMP).

## Keamanan

App ini bisa membaca dan menulis file di server. **Jalankan lokal / di jaringan tertutup**, atau set
`MEDIA_ROOT` di `.env.local` untuk membatasi folder yang bisa diakses, dan tambahkan autentikasi sebelum di-expose ke internet.
