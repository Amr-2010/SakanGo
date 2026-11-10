@echo off
setlocal
REM First create the empty repository https://github.com/Amr-2010/SakanGo in GitHub.
where git >nul 2>nul
if errorlevel 1 (echo Git is required. Install Git for Windows.& exit /b 1)
git init
if errorlevel 1 exit /b 1
git branch -M main
git add .
git commit -m "Initial SakanGo real estate MVP"
git remote remove origin 2>nul
git remote add origin https://github.com/Amr-2010/SakanGo.git
git push -u origin main
if errorlevel 1 echo Push failed. Make sure the repo exists and GitHub authentication is configured.
endlocal
