#!/bin/bash
set -e

echo ""
echo "================================================"
echo "  Real Estate Monitor - Codespaces Setup"
echo "================================================"
echo ""

cd backend
npm install
echo ""
echo "✔ Backend dependencies installed"
echo ""

# Optional: Install Pi CLI
echo "----------------------------------------"
echo "  Pi Collaborating Agents (optional)"
echo "----------------------------------------"
echo ""
echo "To enable /collab-agent-scrape mode,"
echo "Pi CLI needs to be installed."
echo ""

read -p "Install Pi CLI now? (y/N): " INSTALL_PI
if [[ "$INSTALL_PI" == "y" || "$INSTALL_PI" == "Y" ]]; then
    echo ""
    echo "Installing Pi CLI (this may take a few minutes)..."
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent
    echo "✔ Pi CLI installed"
    
    echo "Installing collaborating-agents extension..."
    pi install npm:@baochunli/pi-collaborating-agents
    echo "✔ collaborating-agents extension installed"
    
    echo ""
    echo "Pi is ready. Set PI_RUNTIME_ENABLED=true to use /collab-agent-scrape."
else
    echo ""
    echo "Skipped. To install Pi later, run:"
    echo "  npm install -g @earendil-works/pi-coding-agent"
    echo "  pi install npm:@baochunli/pi-collaborating-agents"
fi

echo ""
echo "================================================"
echo "  Ready! Next steps:"
echo "================================================"
echo ""
echo "  1. Set your API keys:"
echo '     export FIRECRAWL_API_KEY="your-key"'
echo '     export DEEPSEEK_API_KEY="your-key"'
echo ""
echo "  2. (If using Pi) Enable Pi runtime:"
echo '     export PI_RUNTIME_ENABLED="true"'
echo '     export RE_PROJECT_ROOT=$(pwd)'
echo ""
echo "  3. Start the server:"
echo "     cd backend && npx tsx src/index.ts"
echo ""
echo "  4. Codespaces will auto-open port 3742"
echo ""
echo "  5. Try: /collab-agent-scrape I want a 3-bedroom house in Seattle under 1M"
echo ""
echo "================================================"
