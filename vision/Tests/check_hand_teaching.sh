#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
mkdir -p vision/build/hand-teaching
swiftc vision/AtlasVisionTeaching/VisionHandClutch.swift vision/Tests/VisionHandClutchTests.swift -o vision/build/hand-teaching/clutch-tests
vision/build/hand-teaching/clutch-tests
node vision/Tests/hand_teaching_solver.mjs
