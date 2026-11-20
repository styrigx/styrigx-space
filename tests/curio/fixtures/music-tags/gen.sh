#!/bin/sh
# 音乐上传预填（M2 PR-a）读标签单测用的真文件（tests/curio/music-tags.test.mjs）。重新生成：在本目录 sh gen.sh（要 ffmpeg 和 node）。0.1 秒静音。
set -e
ffmpeg -y -loglevel error -f lavfi -i "color=c=0x3366cc:s=40x24" -frames:v 1 cover.jpg
S="-f lavfi -t 0.1 -i anullsrc=r=8000:cl=mono"
ffmpeg -y -loglevel error $S -i cover.jpg -map 0:a -map 1:v -c:a libmp3lame -b:a 8k -c:v copy -disposition:v attached_pic -id3v2_version 3 -metadata title="那天下雨了" -metadata artist="周杰伦" -metadata:s:v comment="Cover (front)" v23-cover.mp3
ffmpeg -y -loglevel error $S -c:a libmp3lame -b:a 8k -id3v2_version 3 -metadata title="Rainy Day" -metadata artist="Jay Chou" v23-latin1.mp3
ffmpeg -y -loglevel error $S -c:a libmp3lame -b:a 8k -id3v2_version 4 -metadata title="晴天" -metadata artist="周杰伦" v24.mp3
ffmpeg -y -loglevel error $S -c:a libmp3lame -b:a 8k -id3v2_version 0 -map_metadata -1 -fflags +bitexact notag.mp3
ffmpeg -y -loglevel error $S -i cover.jpg -map 0:a -map 1:v -c:a flac -c:v copy -disposition:v attached_pic -metadata title="稻香" -metadata artist="周杰伦" tagged.flac
ffmpeg -y -loglevel error $S -c:a flac -map_metadata -1 -fflags +bitexact notag.flac
# ID3v1-only (Latin-1, and GBK bytes as Chinese rippers write them): appended by hand (ffmpeg won't write v1 without v2 here)
node mk-v1.cjs
