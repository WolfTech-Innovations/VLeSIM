#!/bin/bash

# Colors
RED='\033[0;31m'
GREEN='\033[0;92m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

echo -e "${CYAN}VLeSIM${RESET}"
echo -e "${YELLOW}By: WolfTech Innovations.${RESET}"
echo

# Check for node
if ! command -v node &> /dev/null
then
    echo -e "${RED}[X] Node.js is not installed!${RESET}"
    echo -e "${YELLOW}Please install Node.js before running this script.${RESET}"
    exit 1
fi

# Ask for sudo
echo -e "${CYAN}Getting root permissions...${RESET}"
sudo -v
if [ $? -ne 0 ]; then
    echo -e "${RED}[X] Failed to get sudo permissions.${RESET}"
    exit 1
fi
npm install public-ip
# Run the setup script
echo -e "${GREEN}Launching setup and server...${RESET}"
node PrivateCelluarCore.js