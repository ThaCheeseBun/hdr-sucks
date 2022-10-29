# hdr-sucks
libx265 transcoding wrapper with hdr support.

## supported stuffs
* Input file
    * Pretty much anything ffmpeg can decode
* Output file.
    * HEVC video with original audio and subtitles in a Matroska (MKV) file.
* HDR
    * HDR10
    * HLG
    * Dolby Vision
    * HDR10+

## used software
* [ffmpeg](https://ffmpeg.org/) for metadata extraction and video decoding.
* [dovi_tool](https://github.com/quietvoid/dovi_tool) for Dolby Vision support.
* [hdr10plus_tool](https://github.com/quietvoid/hdr10plus_tool) for HDR10+ support.
* [libx265](https://www.videolan.org/developers/x265.html) for the whole encoding process.
* [mkvtoolnix](https://mkvtoolnix.download) for merging the final Matroska file.