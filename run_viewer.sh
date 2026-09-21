#!/bin/bash
# 一鍵啟動 DesktopFly 本地 3D 模擬器與錄影視窗
cd "$(dirname "$0")"

PORT=8765
echo "🚀 正在啟動 DesktopFly 本地 3D 模擬器 (Port: $PORT)..."

# 如果該連接埠已被佔用則先關閉
lsof -ti :$PORT | xargs kill -9 2>/dev/null || true

# 啟動輕量本地伺服器
python3 -m http.server $PORT --directory colab &
SERVER_PID=$!

sleep 0.8
echo "🌐 正在為您打開瀏覽器..."
open "http://localhost:$PORT"

echo "✨ 模擬器運行中 (PID: $SERVER_PID)。"
echo "👉 隨時按 Ctrl + C 即可關閉。"

# 等待中斷信號
trap "kill $SERVER_PID 2>/dev/null; exit 0" INT TERM
wait $SERVER_PID
