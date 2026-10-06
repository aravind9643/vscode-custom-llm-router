<#
.SYNOPSIS
  One-liner installer and deployment script for vscode-custom-llm-router.
.DESCRIPTION
  Initializes environment, verifies local endpoints, and deploys custom language models to VS Code / VS Code Insiders.
#>

$ErrorActionPreference = "Stop"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " 🚀 vscode-custom-llm-router Installer & Deployer" -ForegroundColor Cyan
Write-Host "============================================================`n" -ForegroundColor Cyan

# 1. Check Node.js
if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    Write-Error "❌ Node.js is required but not installed or not in PATH. Please install Node.js (https://nodejs.org)."
    exit 1
}

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) {
    $ScriptDir = Get-Location
}

# 2. Check or initialize .env
$EnvFile = Join-Path $ScriptDir ".env"
$EnvExample = Join-Path $ScriptDir ".env.example"

if (-not (Test-Path $EnvFile) -and (Test-Path $EnvExample)) {
    Write-Host "[1/3] Creating initial .env configuration..." -ForegroundColor Yellow
    Copy-Item $EnvExample $EnvFile
    Write-Host "  ✅ Created .env from template." -ForegroundColor Green
} else {
    Write-Host "[1/3] Environment configuration found (.env)." -ForegroundColor Green
}

# 3. Check status of endpoints
Write-Host "`n[2/3] Checking local backend endpoints..." -ForegroundColor Yellow
& node (Join-Path $ScriptDir "generate-models.js") --status

# 4. Generate and deploy models
Write-Host "`n[3/3] Generating models and deploying to VS Code Insiders..." -ForegroundColor Yellow
& node (Join-Path $ScriptDir "generate-models.js") --fast --apply

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host " ✅ Setup complete! Your models are live in VS Code Insiders." -ForegroundColor Green
Write-Host " Open GitHub Copilot / Chat and pick any custom model." -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
