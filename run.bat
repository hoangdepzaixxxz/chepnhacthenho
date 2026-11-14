@echo off
REM Mo app ban DEV (co day du sua moi nhat). Chay bang cach nhay doi file nay.
cd /d "%~dp0"
REM Tat cac tien trinh electron cu con treo (tranh nhin phai cua so cu)
taskkill /F /IM electron.exe /T >nul 2>&1
call npm start
