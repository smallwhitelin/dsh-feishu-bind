@echo off
cd /d D:\dsh\qrcode-bind
set BIND_TOKEN=linfeishu888
set BIND_PORT=3001
set BIND_HOST=127.0.0.1
"D:\Program Files\nodejs\node.exe" server.js >> D:\dsh\qrcode-bind\page.log 2>&1
