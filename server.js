const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream');
const cron = require('node-cron'); // Bổ sung cron job dọn rác

const app = express();

// Khởi tạo thư mục tạm để lưu file, tránh lưu trực tiếp trên RAM gây sập ứng dụng
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `chunk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.dat`)
});
const upload = multer({ storage: storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// URL API GIỮ NGUYÊN TUYỆT ĐỐI THEO YÊU CẦU
const AUTH_API_URL = process.env.AUTH_API_URL || "https://script.google.com/macros/s/AKfycbw-RDeNdYzo7dMnmMRUV2jLkUSCmIN5Fk87suroVvo_bYjyyO05HEKXUcPyf_RLQ_A/exec";
const BACKUP_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyxpDyYr4IuQgWFTnQV6DDtrtWKDDjKiPYKjOSxgfL2PIDNCRNco5-v7OYux4wVFL-D/exec";

// NÂNG CẤP BẢO MẬT: LƯU BOT_TOKEN VÀ CHAT_ID TẠI BACKEND SERVER
// Khởi tạo biến lưu Credential cấu hình từ Server hoặc lấy sau khi xác thực thành công
let SYSTEM_BOT_TOKEN = process.env.BOT_TOKEN || "";
let SYSTEM_CHAT_ID = process.env.CHAT_ID || "";

// Hàm hỗ trợ Sleep chống Rate Limit Telegram
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// CRON JOB: TỰ ĐỘNG DỌN DẸP FILE RÁC TRONG UPLOADS MỖI 30 PHÚT (XÓA FILE CŨ HƠN 1 GIỜ)
cron.schedule('*/30 * * * *', () => {
  console.log('[Cron Job] Đang kiểm tra dọn dẹp thư mục uploads...');
  fs.readdir(uploadDir, (err, files) => {
    if (err) return console.error('Lỗi đọc thư mục uploads:', err);
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(uploadDir, file);
      fs.stat(filePath, (err, stats) => {
        if (!err) {
          // Nếu file tồn tại hơn 1 giờ (3600000 ms) -> Tiến hành xóa
          if (now - stats.mtimeMs > 3600000) {
            fs.unlink(filePath, (err) => {
              if (!err) console.log(`[Cron Job] Đã xóa file rác quá hạn: ${file}`);
            });
          }
        }
      });
    });
  });
});

// 1. API Đăng nhập
app.post('/api/login', async (req, res) => {
  try {
    const response = await fetch(AUTH_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();

    if (data.success) {
      // Lưu lại Token & ChatId vào hệ thống Server
      SYSTEM_BOT_TOKEN = data.token;
      SYSTEM_CHAT_ID = data.chatId;

      // Trả về cho Client nhưng KHÔNG trả Token và ChatID
      res.json({
        success: true,
        maxGb: data.maxGb || 5,
        mtb: req.body.mtb
      });
    } else {
      res.json(data);
    }
  } catch (err) {
    res.status(500).json({ success: false, message: "Lỗi hệ thống xác thực" });
  }
});

// 2. API Lấy Bản Sao Lưu
app.get('/api/backup', async (req, res) => {
  try {
    const { mtb } = req.query;
    const response = await fetch(`${BACKUP_SCRIPT_URL}?mtb=${encodeURIComponent(mtb)}&t=${Date.now()}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Lỗi tải bản sao lưu" });
  }
});

// 3. API Lưu Bản Sao Lưu
app.post('/api/save-backup', async (req, res) => {
  try {
    const response = await fetch(BACKUP_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. API Upload Chunk (Đã giấu Token về Server + Bảo đảm xóa đĩa tạm triệt để)
app.post('/api/upload-chunk', upload.single('document'), async (req, res) => {
  const filePath = req.file ? req.file.path : null;
  try {
    // Sử dụng Token & ChatID từ Server
    const token = SYSTEM_BOT_TOKEN;
    const chatId = SYSTEM_CHAT_ID;

    if (!token || !chatId || !req.file) {
      return res.status(400).json({ success: false, message: "Thiếu dữ liệu upload hoặc Server chưa đăng nhập" });
    }

    let attempts = 0;
    let tgData = null;

    while (attempts < 3) {
      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('document', fs.createReadStream(filePath), req.file.originalname);

      const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: formData
      });

      tgData = await tgRes.json();

      if (tgRes.status === 429 || (tgData && tgData.error_code === 429)) {
        const retryAfter = (tgData.parameters && tgData.parameters.retry_after) ? tgData.parameters.retry_after : 3;
        console.warn(`[Rate Limit 429] Telegram yêu cầu đợi ${retryAfter} giây...`);
        await sleep((retryAfter + 1) * 1000);
        attempts++;
      } else {
        break;
      }
    }

    if (tgData && tgData.ok && tgData.result.document) {
      res.json({ success: true, file_id: tgData.result.document.file_id });
    } else {
      res.status(400).json({ success: false, message: tgData ? tgData.description : "Lỗi Telegram" });
    }

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    // ĐẢM BẢO XÓA FILE TẠM TRONG MỌI TRƯỜNG HỢP LỖI HOẶC THÀNH CÔNG
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.error("Không thể xóa file tạm:", e);
      }
    }
  }
});

// 5. API Proxy Tải File Stream (Giấu Token về Server + Hỗ trợ Stream & Tua)
app.get('/api/file-proxy', async (req, res) => {
  try {
    const { fileId, filename } = req.query;
    const token = SYSTEM_BOT_TOKEN;

    if (!token || !fileId) return res.status(400).send("Thiếu thông số hoặc Server chưa khởi tạo Token");

    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const infoData = await infoRes.json();

    if (!infoData.ok) return res.status(400).send("Lỗi lấy thông tin file từ Telegram");

    const fileUrl = `https://api.telegram.org/file/bot${token}/${infoData.result.file_path}`;

    // Forward các HTTP Headers hỗ trợ Range Requests để tăng tốc và tua video/audio
    const fetchHeaders = {};
    if (req.headers.range) {
      fetchHeaders['Range'] = req.headers.range;
    }

    const fileStream = await fetch(fileUrl, { headers: fetchHeaders });

    let contentType = 'application/octet-stream';
    if (filename) {
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', 
        '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', 
        '.json': 'application/json; charset=utf-8'
      };
      if (mimeTypes[ext]) contentType = mimeTypes[ext];
    }

    res.status(fileStream.status);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');

    if (fileStream.headers.get('content-range')) {
      res.setHeader('Content-Range', fileStream.headers.get('content-range'));
    }
    if (fileStream.headers.get('content-length')) {
      res.setHeader('Content-Length', fileStream.headers.get('content-length'));
    }

    res.setHeader('Content-Disposition', filename ? `inline; filename="${encodeURIComponent(filename)}"` : 'inline');

    pipeline(fileStream.body, res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('Stream Error:', err);
      }
    });
  } catch (err) {
    res.status(500).send("Lỗi Stream dữ liệu");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy mượt tại cổng ${PORT}`));
