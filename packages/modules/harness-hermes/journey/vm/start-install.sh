#!/bin/bash
# Runs the install detached inside the VM, logging there, so a dropped ssh session cannot hide its state.
cd "$HOME"
nohup bash install.sh > install.log 2>&1 < /dev/null &
disown
echo started
