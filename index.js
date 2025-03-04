/* Copyright (c) 2025, ThaCheeseBun

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE. */

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { basename, join, extname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Command } from "commander";
import chalk from "chalk";

// misc constants
const LOG_PREFIX = chalk.green("[HDRS]");
const TEMP_BASE = ".hdrsucks-";

const X265_PREFIX = chalk.cyan("[x265]");
const X265_REGEX = /([0-9]+) frames: ([0-9]+\.[0-9]+) fps, ([0-9]+\.[0-9]+) kb\/s/;

const MKV_PREFIX = chalk.magenta("[MKVT]");

const OPUS_PREFIX = chalk.blue("[OPUS]");

const FFMPEG_REGEX = /size=(?<size>(?:[0-9]+[a-zA-Z]{2,3})|N\/A)time=(?<time>-*[0-9]{2}:[0-9]{2}:[0-9]{2}.[0-9]{2})bitrate=(?<bitrate>(?:-*[0-9]+\.[0-9]+)|N\/A).*speed=(?<speed>[0-9]+(?:\.[0-9]+)?)x/;

// tools used
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const DOVI_TOOL = process.env.DOVI_PATH || "dovi_tool";
const HDR10PLUS_TOOL = process.env.HDR10PLUS_PATH || "hdr10plus_tool";
const X265 = process.env.X265_PATH || "x265";
const MKVMERGE = process.env.MKVMERGE_PATH || "mkvmerge";

// various translations
const COLOR_RANGE = {
    pc: "full",
    tv: "limited"
};

// generate temporary file name
function generate_temp_name(extra = "") {
    return join(process.cwd(), TEMP_BASE + randomBytes(3).toString("hex") + extra);
}

// "safe" numerator/denominator parser
function parse_slash_number(input) {
    const s = input.split("/");
    if (s.length < 2) {
        return Number(input);
    }
    if (s.length > 2 || isNaN(Number(s[0])) || isNaN(Number(s[1]))) {
        return NaN;
    }
    return Number(s[0]) / Number(s[1]);
}

// parse the pix_fmt to input data for x265
function parse_pix_fmt(input) {
    if (!input.includes("yuv")) {
        throw new Error("Input must be YUV");
    }
    const s = input.split("p");
    return {
        csp: `i${s[0].replace(/\D/g, "")}`,
        depth: s[1].replace(/\D/g, "") || "8"
    }
}

// parse mastering display data for x265
function parse_master_display(p) {
    const o = [];
    const list = [p.green_x, p.green_y, p.blue_x, p.blue_y, p.red_x, p.red_y, p.white_point_x, p.white_point_y, p.max_luminance, p.min_luminance];
    for (const i in list) {
        if (!list[i]) {
            throw new Error("this wrong");
        }
        const num = parse_slash_number(list[i]);
        if (isNaN(num)) {
            throw new Error("this wrong");
        }
        o.push(Math.round(num * ((i > 7) ? 10000 : 50000)));
    }
    return `G(${o[0]},${o[1]})B(${o[2]},${o[3]})R(${o[4]},${o[5]})WP(${o[6]},${o[7]})L(${o[8]},${o[9]})`;
}

// seconds to HH:MM:SS
// loaned from https://stackoverflow.com/a/34841026
function toHHMMSS(secs) {
    const sec_num = parseInt(secs, 10);
    const hours = Math.floor(sec_num / 3600);
    const minutes = Math.floor(sec_num / 60) % 60;
    const seconds = sec_num % 60;

    return [hours, minutes, seconds]
        .map(v => v < 10 ? "0" + v : v)
        .join(":");
}

// run ffprobe and grab info about file
function run_ffprobe(file) {
    return new Promise(res => {
        let bufsOut = [], bufsErr = [];
        const args = [
            "-i", file,
            "-hide_banner",
            "-of", "json",
            "-show_format",
            "-show_streams",
            "-show_frames",
            "-read_intervals", "%+#1"
        ];
        const proc = spawn(FFPROBE, args, {
            stdio: ["ignore", "pipe", "pipe"]
        });
        proc.stdout.on("data", d => bufsOut.push(d));
        proc.stderr.on("data", d => bufsErr.push(d));
        proc.on("exit", c => {
            if (c !== 0) {
                const buf = Buffer.concat(bufsErr);
                return res({ _e: buf.toString().trim() });
            }
            const buf = Buffer.concat(bufsOut);
            res(JSON.parse(buf.toString()));
        });
    });
}

// quick side_data finder for stream or frame
function find(side_data, type) {
    if (side_data && side_data.length > 0) {
        return side_data.find(a => a.side_data_type === type);
    }
    return undefined;
}

// average calc for number array
function average_of(arr) {
    let total = 0;
    for (const n of arr) {
        total += n;
    }
    return total / arr.length;
}

// transcode using x265 through ffmpeg
function transcode(ff_args, x265_args, frames, v) {
    return new Promise(res => {
        const ff_proc = spawn(FFMPEG, ff_args, {
            stdio: ["ignore", "pipe", "ignore"]
        });
        const stdio = v ? ["pipe", "ignore", "inherit"] : ["pipe", "ignore", "pipe"];
        const x265_proc = spawn(X265, x265_args, { stdio });

        if (x265_proc.stderr) {
            let avg = [];
            x265_proc.stderr.on("data", l => {
                const result = X265_REGEX.exec(l.toString());
                if (!result) {
                    return;
                }
                const fps = Number(result[2]);
                if (avg.length === 500) {
                    avg.shift();
                }
                avg.push(fps);
                const avg_ = average_of(avg);
                const doneFrames = Number(result[1]);
                const eta = Math.round((frames - doneFrames) / avg_);
                process.stdout.write(`\r${X265_PREFIX} ${result[1]} / ${frames}, ${result[2]} fps, ${result[3]} kb/s, eta: ${toHHMMSS(eta)}`);
            });
        }

        ff_proc.stdout.pipe(x265_proc.stdin);
        x265_proc.on("exit", c => {
            console.log(`\n${LOG_PREFIX} Done transcoding`);
            res(c);
        });
    });
}

// final mkv merge of old and new file
function mkvmerge(paths, extra_tags, aud_tags, v) {
    return new Promise((res, rej) => {
        let bufsErr = [];
        let mkv_args = [
            "-o", paths.output,
            "--language", `0:${extra_tags.language}`,
            "--default-track-flag", `0:${extra_tags.default}`,
            "--forced-display-flag", `0:${extra_tags.forced}`,
            "--hearing-impaired-flag", `0:${extra_tags.hearing_impaired}`,
            "--visual-impaired-flag", `0:${extra_tags.visual_impaired}`,
            "--text-descriptions-flag", `0:${extra_tags.text_descriptions}`,
            "--original-flag", `0:${extra_tags.original}`,
            "--commentary-flag", `0:${extra_tags.commentary}`,
            paths.temp
        ];
        if (aud_tags.length > 0) {
            for (let i = 0; i < aud_tags.length; i++) {
                mkv_args.push(
                    "--language", `0:${aud_tags[i].language}`,
                    "--default-track-flag", `0:${aud_tags[i].default}`,
                    "--forced-display-flag", `0:${aud_tags[i].forced}`,
                    "--hearing-impaired-flag", `0:${aud_tags[i].hearing_impaired}`,
                    "--visual-impaired-flag", `0:${aud_tags[i].visual_impaired}`,
                    "--text-descriptions-flag", `0:${aud_tags[i].text_descriptions}`,
                    "--original-flag", `0:${aud_tags[i].original}`,
                    "--commentary-flag", `0:${aud_tags[i].commentary}`,
                    paths.audio_temp[i]
                );
            }
            mkv_args.push("--no-audio");
        }
        mkv_args.push(
            "--no-video",
            paths.input
        );
        const stdio = v ? ["ignore", "inherit", "pipe"] : ["ignore", "pipe", "pipe"];
        const proc = spawn(MKVMERGE, mkv_args, { stdio });
        if (proc.stdout) {
            proc.stdout.on("data", l => {
                const str = l.toString();
                if (str.includes("%") && str.split(":").length == 2) {
                    process.stdout.write(`\r${MKV_PREFIX} Progress: ${str.split(":")[1].trim()}`);
                }
            });
        }
        proc.stderr.on("data", d => bufsErr.push(d));
        proc.on("exit", c => {
            if (c !== 0) {
                const buf = Buffer.concat(bufsErr);
                return rej(buf.toString().trim());
            }
            console.log(`\n${LOG_PREFIX} Merge done`);
            res();
        });
    });
}

// detect and extract hdr info
function pre_hdr(stream, frame, paths, v) {
    return new Promise(async (res, rej) => {
        let _temp;
        let done = [false, false, false, false];
        let out = [];
        for (const e of [stream, frame]) {
            if (!e.side_data_list || e.side_data_list.length < 1) {
                continue;
            }

            // HDR10 / HLG
            _temp = find(e.side_data_list, "Mastering display metadata");
            if (!done[0] && _temp) {
                done[0] = true;
                log("Found HDR10 / HLG");
                out.push("--master-display", parse_master_display(_temp));
            }
            _temp = find(e.side_data_list, "Content light level metadata");
            if (!done[1] && _temp) {
                done[1] = true;
                out.push("--max-cll", `${_temp.max_content},${_temp.max_average}`);
            }

            // DOLBY VISION
            _temp = find(e.side_data_list, "DOVI configuration record");
            if (!done[2] && _temp) {
                done[2] = true;
                log("Found Dolby Vision");
                paths.dv = generate_temp_name(".bin");
                const result = await ff_xtract(paths.input, DOVI_TOOL, `extract-rpu -o ${paths.dv} -`.split(" "), v);
                if (result.e) {
                    return rej(`Extracting Dolby Vision failed (${result.c}): "${result.e}"`);
                }
            }

            // HDR10+
            _temp = find(e.side_data_list, "HDR Dynamic Metadata SMPTE2094-40 (HDR10+)");
            if (!done[3] && _temp) {
                done[3] = true;
                log("Found HDR10+");
                paths.plus = generate_temp_name(".json");
                const result = await ff_xtract(paths.input, HDR10PLUS_TOOL, `extract -o ${paths.plus} -`.split(" "), v);
                if (result.e) {
                    return rej(`Extracting HDR10+ failed (${result.c}): "${result.e}"`);
                }
            }
        }
        res(out);
    });

}

// helper function for extraction
function ff_xtract(file, sec, args, v) {
    return new Promise(res => {
        let bufsErr = [];
        const ff_args = [
            "-i", file,
            "-map", "0:v:0?",
            "-c:v", "copy",
            "-bsf:v", "hevc_mp4toannexb",
            "-f", "hevc",
            "-"
        ];
        const stdio1 = v ? ["ignore", "pipe", "inherit"] : ["ignore", "pipe", "ignore"];
        const ff_proc = spawn(FFMPEG, ff_args, { stdio: stdio1 });
        const stdio2 = v ? ["pipe", "inherit", "pipe"] : ["pipe", "ignore", "pipe"];
        const sec_proc = spawn(sec, args, { stdio: stdio2 });
        ff_proc.stdout.pipe(sec_proc.stdin);
        sec_proc.stderr.on("data", d => bufsErr.push(d));
        sec_proc.on("exit", c => {
            if (c === 0) {
                return res({ c, e: null });
            }
            const buf = Buffer.concat(bufsErr);
            res({ c, e: buf.toString().trim() });
        });
    });
}

// reinject hdr metadata after transcoding
function post_hdr(paths) {
    return new Promise(async (res, rej) => {

        let currentFile = paths.temp;
        for (const [k, v] of Object.entries(paths)) {
            let args, tool;

            if (k === "dv" && v) {
                args = [
                    "inject-rpu",
                    "--rpu-in", v
                ];
                tool = DOVI_TOOL;
            } else if (k === "plus" && v) {
                args = [
                    "inject",
                    "-j", v
                ];
                tool = HDR10PLUS_TOOL;
            } else {
                continue;
            }

            const newTemp = generate_temp_name(".hevc");
            args.push("-i", currentFile, "-o", newTemp);

            const result = await ff_inject(tool, args);
            if (result.e) {
                return rej(`Injecting HDR (${k}) failed (${result.c}): "${result.e}"`);
            }

            await rm(currentFile);
            await rm(v);

            currentFile = newTemp;
        }
        res(currentFile);

    });
}

// helper function for injecting
// really just a promised spawn wrapper
function ff_inject(p, args) {
    return new Promise(res => {
        let bufsErr = [];
        const proc = spawn(p, args, {
            stdio: ["ignore", "inherit", "pipe"]
        });
        proc.stderr.on("data", d => bufsErr.push(d));
        proc.on("exit", async c => {
            if (c === 0) {
                return res({ c, e: null });
            }
            const buf = Buffer.concat(bufsErr);
            res({ c, e: buf.toString().trim() });
        });
    });
}

// get duration from ffprobe data
function get_duration(stream, format) {
    if (stream.duration) {
        return Number(stream.duration);
    }
    if (stream.tags) {
        for (const [k, v] of Object.entries(stream.tags)) {
            if (k.toLowerCase().startsWith("duration")) {
                return Date.parse(`1970-01-01T${v}Z`) / 1000;
            } else if (format.duration) {
                return Number(format.duration);
            }
        }
    }
    return NaN;
}

// EXPERIMENTAL opus audio transcoding
function opus_transcode(ff_args, stream_len, v) {
    return new Promise(res => {
        const stdio = v ? ["ignore", "ignore", "inherit"] : ["ignore", "ignore", "pipe"];
        const ff_proc = spawn(FFMPEG, ff_args, { stdio });

        if (ff_proc.stderr) {
            ff_proc.stderr.on("data", d => {
                for (const line of d.toString().replace(/\r/g, "").split("\n")) {
                    if (line.trim().length === 0) {
                        return;
                    }
                    const result = FFMPEG_REGEX.exec(line.replace(/ /g, ""));
                    if (!result) {
                        return;
                    }
                    process.stdout.write(`\r${OPUS_PREFIX} ${result.groups.time} / ${toHHMMSS(stream_len)}, ${result.groups.speed}x`);
                }
            });
        }

        ff_proc.on("exit", c => {
            console.log(`\n${LOG_PREFIX} Done audio transcoding`);
            res(c);
        });
    });
}

// log wrappers for adding prefix
function log(...msg) {
    console.log(LOG_PREFIX, ...msg);
}
function err(...msg) {
    console.error(LOG_PREFIX, chalk.red("[ERROR]"), ...msg);
}
function debug(...msg) {
    console.log(LOG_PREFIX, chalk.gray("[DEBUG]"), ...msg);
}
function warn(...msg) {
    console.log(LOG_PREFIX, chalk.yellow("[WARNING]"), ...msg);
}

// main function
(async () => {

    // global error wrapper
    try {
        // parse command line arguments
        const program = await new Command()
            .argument("<input>", "input file path")
            .argument("[output]", "output file path")

            // quality options
            .option("-p, --preset <string>", "x265 preset to use", "medium")
            .option("-q, --crf <number>", "x265 crf quality", "23")

            // specific settings
            .option("--keep-bit", "8 bit is processed to 10 bit by default, this keeps 8 bit and enables aq mode 3")
            .option("--double-fps", "double fps for interlaced video")

            // debug time related settings
            .option("-t, --time <number>", "[DEBUG] limit time to process")
            .option("-ss, --seek <number>", "[DEBUG] start position")

            // extra
            .option("-o, --args <string>", "add extra x265 arguments")

            // debug options
            .option("-v, --verbose", "more debug info")

            // EXPERIMENTAL opus transcode
            .option("--opus", "EXPERIMENTAL opus audio transcode")
            .option("--opus-bitrate", "opus target bitrate (variable", "128")

            .parseAsync();
        const args = program.processedArgs;
        const opts = program.opts();
        if (opts.verbose) {
            debug("args:", args);
            debug("opts:", opts)
        }

        // store current tempfiles
        let paths = {
            input: resolve(args[0]),
            output: args[1] ? resolve(args[1]) : join(process.cwd(), basename(args[0], extname(args[0])) + ".hdr-sucks.mkv"),
            temp: generate_temp_name(".hevc"),
            dv: null,
            plus: null,
            audio_temp: []
        };

        // log cause why not
        log(`Input file: ${paths.input}`);
        log(`Output file: ${paths.output}`);

        // run ffprobe
        log("Extracting file metadata");
        const d = await run_ffprobe(paths.input);
        if (d._e) {
            return err(`Could not parse with ffprobe: ${d._e}`);
        }

        // content checks
        if (d.streams.length < 1) {
            return err("No streams were found in the file");
        }
        const stream = d.streams.find(x => x.codec_type === "video");
        if (stream === undefined) {
            return err("No video stream was found in the file");
        }
        if (d.frames.length < 1) {
            return err("No frames were found in the video stream");
        }
        const frame = d.frames[0];

        // opus checks
        const audio_streams = d.streams.filter(x => x.codec_type === "audio");
        if (opts.opus && audio_streams.length < 1) {
            warn("Opus requested but no audio streams found");
        }

        // lets start creating arguments
        let ff_args = [
            "-i", paths.input,
            "-map", "0:v:0"
        ];
        let x265_args = [
            "--input", "-",
            "--y4m",
        ];

        // first off, pixel format
        const fmt = parse_pix_fmt(stream.pix_fmt);
        if (opts.verbose) {
            debug("pix_fmt", fmt);
        }
        // keep bit depth if requested and use aq mode 3 for 8 bit
        if (opts.keepBit) {
            x265_args.push("--output-depth", fmt.depth);
            if (fmt.depth === "8") {
                log("Input depth is 8, using \"aq-mode=3\" to improve darker scenes");
                x265_args.push("--aq-mode", "3");
            }
        } else {
            if (fmt.depth === "8") {
                log("Input depth is 8, using output depth 10 to improve darker scenes");
                x265_args.push("--output-depth", "10");
            } else {
                x265_args.push("--output-depth", fmt.depth);
            }
        }

        // add color data if they exist
        if (stream.range) {
            x265_args.push("--range", COLOR_RANGE[stream.color_range]);
        }
        if (stream.color_primaries) {
            x265_args.push("--colorprim", stream.color_primaries);
        }
        if (stream.color_transfer) {
            x265_args.push("--transfer", stream.color_transfer);
        }
        if (stream.color_space) {
            x265_args.push("--colormatrix", stream.color_space);
        }

        // hdr shenanigans
        log("Extracting HDR metadata, this may take a while...");
        const temp_args = await pre_hdr(stream, frame, paths, opts.verbose);
        x265_args.push(...temp_args);

        // export some tags and misc metadata
        const extra_tags = {
            language: "eng",
            default: 0,
            forced: 0,
            hearing_impaired: 0,
            visual_impaired: 0,
            text_descriptions: 0,
            original: 0,
            commentary: 0
        };
        if (stream.tags) {
            for (const [k, v] of Object.entries(stream.tags)) {
                if (k.toLowerCase() === "language") {
                    extra_tags.language = v;
                }
            }
        }
        if (stream.disposition) {
            extra_tags.default = stream.disposition.default;
            extra_tags.forced = stream.disposition.forced;
            extra_tags.hearing_impaired = stream.disposition.hearing_impaired;
            extra_tags.visual_impaired = stream.disposition.visual_impaired;
            extra_tags.text_descriptions = stream.disposition.descriptions;
            extra_tags.original = stream.disposition.original;
            extra_tags.commentary = stream.disposition.comment;
        }

        // add user defined stuff and output path
        x265_args.push(
            "--preset", opts.preset,
            "--crf", opts.crf,
            "--output", paths.temp
        );

        // handle interlaced video
        let fps = parse_slash_number(stream.r_frame_rate);
        if (stream.field_order && stream.field_order !== "progressive") {
            log("Interlaced video, using yadif to deinterlace");
            ff_args.push("-vf", `yadif=${opts.doubleFps ? "1" : "0"}`);
            if (opts.doubleFps) {
                fps *= 2;
            }
        }

        // limit time, used for debugging mostly
        if (opts.time) {
            if (isNaN(Number(opts.time))) {
                return err("Invalid time format");
            }
            ff_args.push("-t", opts.time);
        }

        // add ffmpeg output options
        ff_args.push(
            "-f", "yuv4mpegpipe",
            "-strict", "-1",
            "-"
        );

        // add user supplied arguments if any
        if (opts.args) {
            const s = opts.args.split(":");
            for (const a of s) {
                const ss = a.split("=");
                if (ss.length !== 2) {
                    continue;
                }
                x265_args.push(`--${ss[0]}`, ss[1]);
            }
        }

        // debug logging
        if (opts.verbose) {
            debug("ffmpeg args:", ff_args);
            debug("x265 args:", x265_args);
        }

        // give duration and rough framecount estimate
        const duration = get_duration(stream, d.format);
        const totFrames = Math.ceil((opts.time ? Number(opts.time) : duration) * fps);
        log(
            `Length: ${opts.time || duration}s, ` +
            `Frames: ~${totFrames}`
        );

        // do the actual transcoding
        log("Starting transcode, this will take a while");
        const code = await transcode(ff_args, x265_args, totFrames, opts.verbose);
        if (code !== 0) {
            return err(`Transcode failed: ${code}`);
        }

        // reinject hdr metadata
        log("Injecting HDR metadata if any");
        paths.temp = await post_hdr(paths);

        // opus go brrr
        let aud_tags = [];
        if (opts.opus) {
            for (let i = 0; i < audio_streams.length; i++) {
                console.log(OPUS_PREFIX, "Transcoding audio stream", i);

                paths.audio_temp.push(generate_temp_name(".opus"));
                let aud_args = [
                    "-i", paths.input,
                    "-map", `0:${audio_streams[i].index}`,
                    "-map_chapters", "-1",
                    "-map_metadata", "-1",
                    "-c:a", "libopus",
                    "-b:a", `${opts.opusBitrate}k`,
                    paths.audio_temp[i]
                ];
                const aud_extra_tags = {
                    language: "eng",
                    default: 0,
                    forced: 0,
                    hearing_impaired: 0,
                    visual_impaired: 0,
                    text_descriptions: 0,
                    original: 0,
                    commentary: 0
                };
                if (audio_streams[i].tags) {
                    for (const [k, v] of Object.entries(audio_streams[i].tags)) {
                        if (k.toLowerCase() === "language") {
                            aud_extra_tags.language = v;
                        }
                    }
                }
                if (audio_streams[i].disposition) {
                    aud_extra_tags.default = audio_streams[i].disposition.default;
                    aud_extra_tags.forced = audio_streams[i].disposition.forced;
                    aud_extra_tags.hearing_impaired = audio_streams[i].disposition.hearing_impaired;
                    aud_extra_tags.visual_impaired = audio_streams[i].disposition.visual_impaired;
                    aud_extra_tags.text_descriptions = audio_streams[i].disposition.descriptions;
                    aud_extra_tags.original = audio_streams[i].disposition.original;
                    aud_extra_tags.commentary = audio_streams[i].disposition.comment;
                }
                aud_tags.push(aud_extra_tags);

                const dur = get_duration(audio_streams[i], d.format);
                const code = await opus_transcode(aud_args, dur, opts.verbose);
                if (code !== 0) {
                    return err(`Opus transcode failed: ${code}`);
                }
            }
        }

        // merge file back together
        log("Merging source and temp to output");
        await mkvmerge(paths, extra_tags, aud_tags, opts.verbose);

        // cleanup
        log("Cleaning up");
        await rm(paths.temp);
        for (const temp_file of paths.audio_temp) {
            await rm(temp_file);
        }

    } catch (e) {
        err(e);
    }

})();
