#!/bin/bash

res_1080_60() {
    DISPLAY=:0 xrandr --output HDMI-1 --mode 1920x1080 --rate 60
}
res_1080_30() {
    DISPLAY=:0 xrandr --output HDMI-1 --mode 1920x1080 --rate 30
}

res_1080_60