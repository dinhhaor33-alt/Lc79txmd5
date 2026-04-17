const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Storage
let history = [];
let predHistory = [];
let currentTick = null;
let lastPrediction = null;
let lastSnapshot10s = null;

// Biến trạng thái
let consecutiveWrong = 0;
let followStreakMode = false;
let lastResult = null;

// Auth
const USERNAME = process.env.TELE68_USER || "dinhhaor150";
const PASSWORD = process.env.TELE68_PASS || "dinhvuhao5";
let currentToken = "";

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        "Origin": "https://lc79b.bet",
        "User-Agent": "Mozilla/5.0"
      }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    }).on("error", reject);
  });
}

function httpPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        "Origin": "https://lc79b.bet",
        "User-Agent": "Mozilla/5.0"
      }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

async function login() {
  const pwMd5 = md5(PASSWORD);
  console.log('[AUTH] Đang đăng nhập...');
  
  const preAuth = await httpGet(
    `https://apifo88daigia.tele68.com/api?c=3&un=${USERNAME}&pw=${pwMd5}&cp=R&cl=R&pf=web&at=`
  );
  
  const accessToken = preAuth.accessToken || preAuth.data?.accessToken;
  const nickName = preAuth.nickName || preAuth.data?.nickName;
  
  if (!accessToken) throw new Error("Không lấy được accessToken");
  
  const loginResp = await httpPost(
    "https://wlb.tele68.com/v1/lobby/auth/login?cp=R&cl=R&pf=web&at=",
    { nickName: nickName || "vuhao212", accessToken }
  );
  
  const token = loginResp.token || loginResp.data?.token;
  if (!token) throw new Error("Không lấy được token");
  
  console.log('[AUTH] ✅ Đăng nhập thành công!');
  currentToken = token;
  return token;
}

function isTokenExpiringSoon(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    const now = Math.floor(Date.now() / 1000);
    return payload.exp - now < 1800;
  } catch {
    return true;
  }
}

// WebSocket connection
const WS_URL = "wss://wtxmd52.tele68.com/txmd5/?EIO=4&transport=websocket";
let ws = null;

async function connectWS() {
  if (!currentToken || isTokenExpiringSoon(currentToken)) {
    try {
      await login();
    } catch (e) {
      console.error('[AUTH] ❌ Login failed:', e.message);
      setTimeout(connectWS, 10000);
      return;
    }
  }

  console.log('[WS] Connecting...');
  ws = new WebSocket(WS_URL, {
    headers: {
      "Origin": "https://lc79b.bet",
      "User-Agent": "Mozilla/5.0"
    }
  });

  ws.on('open', () => {
    console.log('[WS] ✅ Connected!');
  });

  ws.on('message', async (data) => {
    const txt = data.toString();
    
    if (txt.startsWith('0{')) {
      ws.send(`40/txmd5,{"token":"${currentToken}"}`);
      return;
    }
    if (txt === '2') { ws.send('3'); return; }
    
    if (txt.includes('"unauthorized"')) {
      console.log('[AUTH] Token rejected, re-login...');
      try {
        await login();
        ws.close();
      } catch (e) {
        console.error('[AUTH] Re-login failed:', e.message);
      }
      return;
    }

    const m = txt.match(/^42\/txmd5,(\[.+\])$/s);
    if (!m) return;
    
    try {
      const [event, payload] = JSON.parse(m[1]);
      
      if (event === 'tick-update') {
        currentTick = {
          id: payload.id,
          tick: payload.tick,
          subTick: payload.subTick,
          state: payload.state,
          data: payload.data
        };

        const d = currentTick;
        // KHOÁ DỰ ĐOÁN TẠI 10 GIÂY
        if (d.state === 'BETTING' && d.subTick === 10 && d.data) {
          const data = d.data;
          const total = data.totalAmountPerType.TAI + data.totalAmountPerType.XIU;
          if (total > 0) {
            const taiPct = data.totalAmountPerType.TAI / total * 100;
            const xiuPct = 100 - taiPct;
            const streak = getStreak(history);
            const signal = calcSignalV5(taiPct, xiuPct, d.subTick, d.state, streak, total);
            
            if (signal.pick && (!lastPrediction || lastPrediction.id !== d.id)) {
              lastPrediction = {
                id: d.id,
                predicted: signal.pick,
                confidence: signal.confidence
              };

              lastSnapshot10s = {
                id: d.id,
                time: new Date().toISOString(),
                tick: d.subTick,
                taiPct: parseFloat(taiPct.toFixed(2)),
                xiuPct: parseFloat(xiuPct.toFixed(2)),
                taiAmt: data.totalAmountPerType.TAI,
                xiuAmt: data.totalAmountPerType.XIU,
                totalAmt: total,
                prediction: signal.pick,
                confidence: signal.confidence
              };

              console.log(`[PRED] #${d.id}: Dự đoán ${signal.pick} (${signal.confidence.toFixed(0)}%) [V5] - Sai LT: ${consecutiveWrong}`);

              fs.appendFile('snapshots_10s.jsonl', JSON.stringify(lastSnapshot10s) + '\n', (err) => {
                if (err) console.error('[FILE] Lỗi lưu snapshot 10s:', err.message);
                else console.log(`[SNAPSHOT] Đã lưu dữ liệu 10s cho phiên #${d.id}`);
              });
            }
          }
        }
      } else if (event === 'session-result') {
        const entry = {
          sessionId: payload.md5Raw.split(':')[0],
          result: payload.resultTruyenThong,
          dice: payload.dices
        };
        history.unshift(entry);
        if (history.length > 100) history = history.slice(0, 100);
        console.log(`[RESULT] #${entry.sessionId}: ${entry.result}`);
        
        lastResult = entry.result;
        
        if (currentTick && currentTick.data) {
          const data = currentTick.data;
          const total = data.totalAmountPerType.TAI + data.totalAmountPerType.XIU;
          const taiAmt = data.totalAmountPerType.TAI;
          const xiuAmt = data.totalAmountPerType.XIU;
          const taiPct = total > 0 ? (taiAmt / total * 100) : 0;
          const xiuPct = 100 - taiPct;
          
          const sessionData = {
            id: parseInt(entry.sessionId),
            md5: payload.md5Raw.split(':')[1] || '',
            result: entry.result,
            dices: entry.dice,
            sum: entry.dice.reduce((a, b) => a + b, 0),
            totalAmt: total,
            taiAmt: taiAmt,
            xiuAmt: xiuAmt,
            taiPct: parseFloat(taiPct.toFixed(2)),
            xiuPct: parseFloat(xiuPct.toFixed(2)),
            velTai: parseFloat(taiPct.toFixed(2)),
            velXiu: parseFloat(xiuPct.toFixed(2)),
            tickCount: currentTick.tick || 0,
            time: new Date().toISOString()
          };
          
          const line = JSON.stringify(sessionData) + '\n';
          fs.appendFile('sessions.jsonl', line, (err) => {
            if (err) console.error('[FILE] Error saving sessions:', err.message);
            else console.log(`[FILE] Saved #${entry.sessionId} to sessions.jsonl`);
          });
        }

        if (lastPrediction && lastPrediction.id == entry.sessionId && lastSnapshot10s) {
          const correct = lastPrediction.predicted === entry.result;
          
          if (correct) {
            consecutiveWrong = 0;
            const streak = getStreak(history);
            if (streak.count < 3) followStreakMode = false;
          } else {
            consecutiveWrong++;
            const streak = getStreak(history);
            if (consecutiveWrong >= 2 && streak.count >= 3) {
              followStreakMode = true;
              console.log(`[MODE] Kích hoạt THEO CHUỖI (thua ${consecutiveWrong}, chuỗi ${streak.count} ${streak.type})`);
            }
          }
          
          const predEntry = {
            id: parseInt(entry.sessionId),
            predicted: lastPrediction.predicted,
            confidence: lastPrediction.confidence,
            result: entry.result,
            dices: entry.dice,
            correct: correct,
            time: new Date().toISOString()
          };
          
          fs.appendFile('predictions.jsonl', JSON.stringify(predEntry) + '\n', (err) => {
            if (err) console.error('[FILE] Error saving prediction:', err.message);
            else console.log(`[PRED] Saved prediction #${entry.sessionId} to predictions.jsonl`);
          });
          
          predHistory.unshift(predEntry);
          if (predHistory.length > 50) predHistory = predHistory.slice(0, 50);

          const trainingEntry = {
            ...lastSnapshot10s,
            result: entry.result,
            dices: entry.dice,
            sum: entry.dice.reduce((a, b) => a + b, 0),
            correct: correct,
            resultTime: new Date().toISOString()
          };

          fs.appendFile('training_data.jsonl', JSON.stringify(trainingEntry) + '\n', (err) => {
            if (err) console.error('[FILE] Lỗi lưu training data:', err.message);
            else console.log(`[TRAINING] Đã lưu dữ liệu huấn luyện cho phiên #${entry.sessionId}`);
          });

          console.log(`[PRED] #${entry.sessionId}: ${lastPrediction.predicted} → ${entry.result} ${correct ? '✅' : '❌'} (Sai LT: ${consecutiveWrong})`);
          
          lastPrediction = null;
          lastSnapshot10s = null;
        }
      } else if (event === 'new-session') {
        console.log(`[NEW] #${payload.id}`);
      }
    } catch (e) {
      console.error('[WS] Parse error:', e.message);
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });

  ws.on('close', () => {
    console.log('[WS] Disconnected, reconnecting in 5s...');
    setTimeout(connectWS, 5000);
  });
}

// Helper functions
function getStreak(hist) {
  if (!hist.length) return { count: 0, type: '--' };
  const first = hist[0].result;
  let count = 0;
  for (const h of hist) { if (h.result === first) count++; else break; }
  return { count, type: first };
}

// THUẬT TOÁN V5 – Chống chuỗi thua, lọc tín hiệu yếu, bẫy thông minh hơn
function calcSignalV5(taiPct, xiuPct, tick, state, streak, totalAmt) {
  if (state !== 'BETTING' || tick > 30) {
    return { icon: '⏳', text: 'Chờ dữ liệu', confidence: 0, pick: null };
  }

  let scoreTai = 50, scoreXiu = 50;
  const diff = Math.abs(taiPct - xiuPct);
  
  // Điều chỉnh ngưỡng bẫy dựa trên chuỗi thua và tổng tiền
  let trapThreshold = 18;
  if (consecutiveWrong >= 2) trapThreshold = 22;
  if (totalAmt < 150000000) trapThreshold += 3; // Nếu tiền ít, tăng ngưỡng
  
  // 1. BẪY DÒNG TIỀN (chỉ khi vượt ngưỡng và tổng tiền đủ lớn)
  if (diff > trapThreshold && totalAmt > 120000000) {
    if (taiPct > xiuPct) {
      scoreXiu += 24;
    } else {
      scoreTai += 24;
    }
  } else {
    // 2. XỬ LÝ CẦU XEN KẼ (trọng số 18)
    const recent2 = history.slice(0, 2);
    if (recent2.length >= 2 && recent2[0].result !== recent2[1].result) {
      if (recent2[0].result === 'TAI') {
        scoreXiu += 18;
      } else {
        scoreTai += 18;
      }
    } else {
      // 3. THEO DÒNG TIỀN (chênh lệch nhỏ)
      if (taiPct > xiuPct) {
        scoreTai += diff * 0.6;
      } else {
        scoreXiu += diff * 0.6;
      }
    }
  }
  
  // 4. CHUỖI DÀI (>=3): ưu tiên theo chuỗi
  if (streak.count >= 3) {
    let bonus = Math.min(streak.count * 2, 14);
    if (consecutiveWrong >= 2) bonus = Math.floor(bonus * 0.6);
    if (streak.type === 'TAI') {
      scoreTai += bonus;
    } else {
      scoreXiu += bonus;
    }
  }

  const totalScore = scoreTai + scoreXiu;
  const taiConf = scoreTai / totalScore * 100;
  const xiuConf = scoreXiu / totalScore * 100;
  const pick = taiConf > xiuConf ? 'TAI' : 'XIU';
  const confidence = Math.max(taiConf, xiuConf);
  
  const pointDiff = Math.abs(scoreTai - scoreXiu);
  // Tăng ngưỡng lọc tín hiệu yếu
  if (pointDiff < 8) {
    return { icon: '😴', text: 'Tín hiệu yếu — Bỏ qua', confidence: 0, pick: null };
  }
  
  let icon = '🤔';
  if (pointDiff >= 25) icon = '🎯';
  else if (pointDiff >= 12) icon = '📈';

  return { icon, text: `${pick} — ${confidence.toFixed(0)}%`, confidence, pick };
}

// ---------- API Routes ----------
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Tài Xỉu API - V5 (Advanced Anti-Trap)' });
});

app.get('/api/snapshot', (req, res) => {
  res.json({ tick: currentTick, history: history.slice(0, 30), predictions: predHistory });
});

app.get('/api/dudoan', (req, res) => {
  if (!currentTick || !currentTick.data) {
    return res.json({ error: 'Chưa có dữ liệu' });
  }

  const d = currentTick;
  const data = d.data;
  const total = data.totalAmountPerType.TAI + data.totalAmountPerType.XIU;
  
  if (total <= 0) return res.json({ error: 'Chưa có dữ liệu cược' });

  const taiPct = data.totalAmountPerType.TAI / total * 100;
  const xiuPct = 100 - taiPct;
  const streak = getStreak(history);
  const signal = calcSignalV5(taiPct, xiuPct, d.subTick, d.state, streak, total);
  
  if (d.state === 'BETTING' && d.subTick === 10 && signal.pick && (!lastPrediction || lastPrediction.id !== d.id)) {
    lastPrediction = {
      id: d.id,
      predicted: signal.pick,
      confidence: signal.confidence
    };
    if (!lastSnapshot10s) {
      lastSnapshot10s = {
        id: d.id,
        time: new Date().toISOString(),
        tick: d.subTick,
        taiPct: parseFloat(taiPct.toFixed(2)),
        xiuPct: parseFloat(xiuPct.toFixed(2)),
        taiAmt: data.totalAmountPerType.TAI,
        xiuAmt: data.totalAmountPerType.XIU,
        totalAmt: total,
        prediction: signal.pick,
        confidence: signal.confidence
      };
    }
    console.log(`[PRED] #${d.id}: Dự đoán ${signal.pick} (${signal.confidence.toFixed(0)}%) (qua API V5)`);
  }
  
  res.json({
    sessionId: d.id,
    tick: d.subTick,
    state: d.state,
    taiPct: taiPct.toFixed(2),
    xiuPct: xiuPct.toFixed(2),
    prediction: signal.pick,
    confidence: signal.confidence.toFixed(1),
    icon: signal.icon,
    text: signal.text,
    streak: streak
  });
});

app.post('/api/dulieu', (req, res) => {
  const { sessionId, result, dice } = req.body;
  if (!sessionId || !result) {
    return res.json({ error: 'Thiếu dữ liệu' });
  }
  
  const entry = { sessionId, result, dice };
  history.unshift(entry);
  if (history.length > 100) history = history.slice(0, 100);
  
  console.log(`[DATA] Saved #${sessionId}: ${result}`);
  res.json({ success: true });
});

app.get('/api/sessions', (req, res) => {
  fs.readFile('sessions.jsonl', 'utf8', (err, data) => {
    if (err) {
      return res.json({ error: 'Chưa có dữ liệu', sessions: [] });
    }
    const lines = data.trim().split('\n').filter(l => l);
    const sessions = lines.map(l => {
      try { return JSON.parse(l); }
      catch { return null; }
    }).filter(s => s);
    res.json({ sessions, count: sessions.length });
  });
});

app.delete('/api/sessions', (req, res) => {
  fs.unlink('sessions.jsonl', (err) => {
    if (err && err.code !== 'ENOENT') {
      return res.json({ error: 'Lỗi xóa file' });
    }
    console.log('[FILE] Deleted sessions.jsonl');
    res.json({ success: true, message: 'Đã xóa dữ liệu' });
  });
});

app.get('/api/dungsai', (req, res) => {
  const limit = parseInt(req.query.limit) || null;
  const offset = parseInt(req.query.offset) || 0;
  
  fs.readFile('predictions.jsonl', 'utf8', (err, data) => {
    if (err) {
      return res.json({ error: 'Chưa có dữ liệu dự đoán', predictions: [], total: 0 });
    }
    const lines = data.trim().split('\n').filter(l => l);
    const predictions = lines.map(l => {
      try { return JSON.parse(l); }
      catch { return null; }
    }).filter(p => p);
    
    predictions.sort((a, b) => b.id - a.id);
    
    const total = predictions.length;
    let result = predictions;
    if (limit !== null && limit > 0) {
      const start = offset;
      const end = offset + limit;
      result = predictions.slice(start, end);
    }
    res.json({ predictions: result, total });
  });
});

app.delete('/api/dungsai', (req, res) => {
  fs.unlink('predictions.jsonl', (err) => {
    if (err && err.code !== 'ENOENT') {
      return res.json({ error: 'Lỗi xóa file' });
    }
    console.log('[FILE] Deleted predictions.jsonl');
    predHistory = [];
    res.json({ success: true, message: 'Đã xóa dữ liệu dự đoán' });
  });
});

app.get('/api/snapshots10s', (req, res) => {
  fs.readFile('snapshots_10s.jsonl', 'utf8', (err, data) => {
    if (err) {
      return res.json({ error: 'Chưa có dữ liệu', snapshots: [] });
    }
    const lines = data.trim().split('\n').filter(l => l);
    const snapshots = lines.map(l => {
      try { return JSON.parse(l); }
      catch { return null; }
    }).filter(s => s);
    res.json({ snapshots, count: snapshots.length });
  });
});

app.get('/api/training-data', (req, res) => {
  const limit = parseInt(req.query.limit) || null;
  const offset = parseInt(req.query.offset) || 0;

  fs.readFile('training_data.jsonl', 'utf8', (err, data) => {
    if (err) {
      return res.json({ error: 'Chưa có dữ liệu huấn luyện', data: [], total: 0 });
    }
    const lines = data.trim().split('\n').filter(l => l);
    const training = lines.map(l => {
      try { return JSON.parse(l); }
      catch { return null; }
    }).filter(t => t);
    
    training.sort((a, b) => b.id - a.id);
    
    const total = training.length;
    let result = training;
    if (limit !== null && limit > 0) {
      const start = offset;
      const end = offset + limit;
      result = training.slice(start, end);
    }
    res.json({ data: result, total });
  });
});

// Start
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`👤 User: ${USERNAME}`);
  console.log(`🧠 Thuật toán: V5 – Bẫy thông minh, chống chuỗi thua`);
  connectWS();
});
