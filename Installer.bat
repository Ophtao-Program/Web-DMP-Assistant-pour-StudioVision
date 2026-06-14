@echo off
title Installation — WebDMP Assistant
cd /d "%~dp0"

echo ================================================
echo  Installation WebDMP Assistant
echo ================================================
echo.

:: Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Node.js introuvable.
    echo Telechargez-le sur https://nodejs.org (version LTS recommandee)
    pause
    exit /b 1
)
echo [OK] Node.js detecte : 
node --version

:: Python
where python >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Python introuvable.
    echo Telechargez-le sur https://python.org
    pause
    exit /b 1
)
echo [OK] Python detecte :
python --version

:: Dépendances Python
echo.
echo Installation des modules Python...
pip install -r requirements.txt
if errorlevel 1 (
    echo [AVERTISSEMENT] Certains modules Python n'ont pas pu etre installes.
    echo Verifiez votre connexion ou installez-les manuellement :
    echo   pip install pyodbc pywin32
)
echo [OK] Modules Python installes.

:: Dépendances Node.js
echo.
echo Installation des dependances Node.js (Electron)...
call npm install
if errorlevel 1 (
    echo [ERREUR] Echec npm install
    pause
    exit /b 1
)
echo [OK] Dependances Node.js installees.

:: Build TypeScript
echo.
echo Compilation TypeScript...
call npm run build
if errorlevel 1 (
    echo [ERREUR] Echec compilation TypeScript
    pause
    exit /b 1
)
echo [OK] Compilation reussie.

echo.
echo ================================================
echo  Installation terminee !
echo  Lancez "Lancer WebDMP.bat" pour demarrer.
echo ================================================
echo.
pause
