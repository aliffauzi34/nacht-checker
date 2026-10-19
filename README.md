# Nacht Checker

App Next.js (App Router, TypeScript) untuk:

1. **Cek Video & Audio**:
   - Deteksi kestabilan bitrate video (CBR / VBR / Mendekati CBR) dengan grafik bitrate per detik.
   - Deteksi detail audio: **Sample Rate Audio** (misal 48.000 Hz vs 44.100 Hz vs 96.000 Hz), Codec/Format (AAC, MP3, WAV, FLAC), Channel (Stereo/Mono), dan Bitrate Audio.
   - Peringatan otomatis jika ditemukan variasi/selisih Sample Rate audio antar file yang dapat menyebabkan desync/audio drift saat editing atau streaming.
2. **Standarisasi & Konversi Masal**:
   - **Mode Cepat (Fast Normalization)**: Menyalin stream video tanpa encode ulang (`-c:v copy`), hanya me-resample dan menstandarkan audio ke sample rate target (misal 48 kHz AAC/WAV/MP3). Proses sangat kilat (1–3 detik/file).
   - **Mode Video CBR**: Re-encode video menjadi CBR murni (x264 filler data) sekaligus menstandarkan audio sample rate.
   - **Mode Audio Saja**: Ekstrak atau konversi semua media menjadi file audio seragam (WAV, MP3, AAC, FLAC).

## Persiapan

Butuh **ffmpeg + ffprobe** terinstall (dengan libx264, libmp3lame, aac) dan Node.js 18.18+.

```bash
# Ubuntu/Debian
sudo apt install ffmpeg
# Windows: download dari ffmpeg.org lalu tambahkan ke PATH
#   atau set FFMPEG_PATH / FFPROBE_PATH di .env.local
```

## Jalankan

```bash
npm install
npm run dev        # Mode Development: http://localhost:3000
# Produksi:
npm run build && npm start
```

## Cara Pakai

1. Masukkan path folder (atau file media) di input path, klik **Cek Media**.
2. Periksa daftar file:
   - Kolom **Sample Rate Audio**: Menampilkan frekuensi sampling (misal `48.000 Hz` atau `44.100 Hz`). Jika ada perbedaan, sistem akan memberi badge kontras dan banner peringatan.
   - Kolom **Bitrate Video**: Menampilkan grafik kestabilan bitrate per detik (sparkline) dan status CBR/VBR.
3. Gunakan tombol cepat seleksi:
   - **Pilih beda Sample Rate**: Otomatis memilih semua file yang sample rate audionya berbeda dari target (misal yang bukan 48 kHz).
   - **Pilih bukan CBR**: Memilih file video yang bitrate-nya masih VBR.
4. Pilih mode konversi di panel bawah:
   - **⚡ Normalisasi Audio Cepat**: Hanya resample audio tanpa re-encode video (sangat cepat).
   - **🎬 Re-encode Video ke CBR + Normalisasi Audio**: Video CBR + Audio seragam.
   - **🎵 Ekstrak / Konversi ke File Audio Saja**: Output berupa file audio mandiri.
5. Tentukan target Sample Rate (misal `48.000 Hz`), Format Audio (AAC/MP3/WAV/FLAC), Bitrate, dan Channel (Stereo/Mono), lalu klik tombol konversi.
6. Hasil disimpan di folder output baru (`cbr_output/` atau `normalized_output/`). File asli aman dan tidak tersentuh.

## Keamanan

App ini membaca dan menulis file lokal di filesystem server. **Jalankan lokal / di jaringan tertutup**, atau set `MEDIA_ROOT` di `.env.local` untuk membatasi folder yang bisa diakses.
