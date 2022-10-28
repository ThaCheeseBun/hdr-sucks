/* Copyright (c) 2022, ThaCheeseBun

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
import { basename, join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { Command } from "commander";

const TEMP_BASE = join(process.cwd(), ".temp-");

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
    return TEMP_BASE + randomBytes(3).toString("hex") + extra;
}

// convert readable stream into buffer
function stream_to_buffer(stream) {
    return new Promise((res, rej) => {
        const bufs = [];
        stream.on("data", chunk => bufs.push(chunk));
        stream.on("end", () => res(Buffer.concat(bufs)));
        stream.on("error", err => rej(err));
    });
}

// "safe" numerator/denominator parser
function parse_slash_number(input) {
    const s = input.split("/");
    if (s.length < 2)
        return Number(input);
    if (s.length > 2)
        return NaN;
    if (isNaN(Number(s[0])) || isNaN(Number(s[1])))
        return NaN;
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
        if (!list[i])
            throw new Error("this wrong");
        const num = parse_slash_number(list[i]);
        if (isNaN(num))
            throw new Error("this wrong");
        o.push(Math.round(num * ((i > 7) ? 10000 : 50000)));
    }
    return `G(${o[0]},${o[1]})B(${o[2]},${o[3]})R(${o[4]},${o[5]})WP(${o[6]},${o[7]})L(${o[8]},${o[9]})`;
}

// run ffprobe and grab info about file
function run_ffprobe(file) {
    return new Promise((res, rej) => {
        const args = [
            "-i", file,
            "-hide_banner",
            "-of", "json",
            "-select_streams", "v:0",
            "-show_format",
            "-show_streams",
            "-show_frames",
            "-read_intervals", "%+#1"
        ];
        const proc = spawn(FFPROBE, args, {
            stdio: ["ignore", "pipe", "pipe"]
        });
        proc.on("exit", async c => {
            if (c !== 0) {
                const buf = await stream_to_buffer(proc.stderr);
                return res({ error: buf.toString().trim() });
            }
            const buf = await stream_to_buffer(proc.stdout);
            res(JSON.parse(buf.toString()));
        });
    });
}

// quick side_data finder for stream or frame
function find(side_data, type) {
    if (side_data && side_data.length > 0)
        return side_data.find(a => a.side_data_type === type);
    return undefined;
}

// transcode using x265 through ffmpeg
function transcode(ff_args, x265_args) {
    return new Promise((res, rej) => {
        const ff_proc = spawn(FFMPEG, ff_args, {
            stdio: ["ignore", "pipe", "ignore"]
        });
        const x265_proc = spawn(X265, x265_args, {
            stdio: ["pipe", "ignore", "inherit"]
        });
        ff_proc.stdout.pipe(x265_proc.stdin);
        x265_proc.on("exit", c => res(c));
    });
}

// final mkv merge of old and new file
function mkvmerge(mkv_args) {
    return new Promise((res, rej) => {
        const mkv_proc = spawn(MKVMERGE, mkv_args, {
            stdio: ["ignore", "inherit", "inherit"]
        });
        mkv_proc.on("exit", c => res(c));
    });
}

// detect and extract hdr info
function pre_hdr(stream, frame, paths) {
    return new Promise(async (res, rej) => {
        let _temp;
        let done = [false, false, false, false];
        let out = [];
        for (const e of [stream, frame]) {
            if (!e.side_data_list || e.side_data_list.length < 1)
                continue;

            // HDR10 / HLG
            _temp = find(e.side_data_list, "Mastering display metadata");
            if (!done[0] && _temp) {
                done[0] = true;
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
                paths.dv = generate_temp_name(".bin");
                const wang = await ff_xtract(paths.input, DOVI_TOOL, `extract-rpu -o ${paths.dv} -`.split(" "));
                console.log(wang);
            }

            // HDR10+
            _temp = find(e.side_data_list, "HDR Dynamic Metadata SMPTE2094-40 (HDR10+)");
            if (!done[3] && _temp) {
                done[3] = true;
                paths.plus = generate_temp_name(".json");
                const wang = await ff_xtract(paths.input, HDR10PLUS_TOOL, `extract -o ${paths.plus} -`.split(" "));
                console.log(wang);
            }
        }
        res(out);
    });
    
}

// reinject hdr metadata after transcoding
function post_hdr(paths) {
    return new Promise(async (res, rej) => {
        let currentFile = paths.temp;
        if (paths.dv) {
            const newTemp = generate_temp_name(".hevc");
            const args = [
                "inject-rpu",
                "-i", currentFile,
                "--rpu-in", paths.dv,
                "-o", newTemp
            ];
            const wang = await ff_inject(DOVI_TOOL, args);
            console.log(wang);
            await rm(currentFile);
            await rm(paths.dv);
            currentFile = newTemp;
        }
        if (paths.plus) {
            const newTemp = generate_temp_name(".hevc");
            const args = [
                "inject",
                "-i", currentFile,
                "-j", paths.plus,
                "-o", newTemp
            ];
            const wang = await ff_inject(HDR10PLUS_TOOL, args);
            console.log(wang);
            await rm(currentFile);
            await rm(paths.plus);
            currentFile = newTemp;
        }
        paths.temp = currentFile;
        res();
    });
}

// helper function for extraction and injection
function ff_xtract(file, sec, sec_args) {
    return new Promise((res, rej) => {
        const ff_args = [
            "-i", file,
            "-map", "0:v:0?",
            "-c:v", "copy",
            "-bsf:v", "hevc_mp4toannexb",
            "-f", "hevc",
            "-"
        ];
        const ff_proc = spawn(FFMPEG, ff_args, {
            stdio: ["ignore", "pipe", "inherit"]
        });
        const sec_proc = spawn(sec, sec_args, {
            stdio: ["pipe", "inherit", "inherit"]
        });
        ff_proc.stdout.pipe(sec_proc.stdin);
        sec_proc.on("exit", c => res(c));
    });
}
function ff_inject(p, p_args) { // this function is just stupid
    return new Promise((res, rej) => {
        const p_proc = spawn(p, p_args, {
            stdio: ["ignore", "inherit", "inherit"]
        });
        p_proc.on("exit", c => res(c));
    });
}

// main function
(async () => {

    // parse command line arguments
    const program = await new Command()
        .name("hdr-sucks")
        .description("libx265 transcoding wrapper with hdr support")
        .version("0.0.1")
        .argument("<input>", "input file path")
        .argument("[output]", "output file path")
        .option("-v, --verbose", "more debug info")
        .option("-hf, --half-fps", "do not double fps for interlaced video")
        .option("-p, --preset <string>", "x265 preset to use", "ultrafast")
        .option("-q, --crf <number>", "x265 crf quality", "26")
        .parseAsync();
    const args = program.processedArgs;
    const opts = program.opts();
    if (opts.verbose)
		console.log(args, opts);

    // store current tempfiles
    let paths = {
        input: args[0],
        output: args[1] || join(process.cwd(), basename(args[0], extname(args[0])) + ".hdr-sucks.mkv"),
        temp: generate_temp_name(".hevc"),
        dv: null,
        plus: null
    };

    // run ffprobe
    const d = await run_ffprobe(paths.input);
    if (d.error)
        return console.error(`Could not parse data with ffprobe: ${d.error}`);

    // content checks
    if (d.streams.length < 1)
        return console.error("No video stream was found in the file");
    const stream = d.streams[0];
    if (d.frames.length < 1)
        return console.error("No frames were found in the file");
    const frame = d.frames[0];

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
    x265_args.push("--output-depth", fmt.depth);
    // also set aq-mode to 3 for 8bit
    if (fmt.depth === 8)
        x265_args.push("--aq-mode", "3");
    if (opts.verbose)
        console.log(fmt);

    // add color data if they exist
    if (stream.range)
        x265_args.push("--range", COLOR_RANGE[stream.color_range]);
    if (stream.color_primaries)
        x265_args.push("--colorprim", stream.color_primaries);
    if (stream.color_transfer)
        x265_args.push("--transfer", stream.color_transfer);
    if (stream.color_space)
        x265_args.push("--colormatrix", stream.color_space);

    // hdr shenanigans begins
    const temp_args = await pre_hdr(stream, frame, paths);
    x265_args.push(...temp_args);

    // add user defined stuff and output path
    x265_args.push(
        "--preset", opts.preset,
        "--crf", opts.crf,
        "--output", paths.temp
    );

    // handle interlaced video
    if (stream.field_order && stream.field_order !== "progressive") {
        console.log("Interlaced video, using yadif to deinterlace");
        ff_args.push("-vf", `yadif=${opts["half-fps"] ? "0" : "1"}`);
    }

    // temp
    //ff_args.push("-t", "30");

    // add ffmpeg output options
    ff_args.push(
        "-f", "yuv4mpegpipe",
        "-strict", "-1",
        "-"
    );

    // debug logging
    if (opts.verbose)
        console.log(x265_args, ff_args);

    // give duration and rough framecount estimate
    const duration = Number(stream.duration || d.format.duration);
    console.log(`Duration: ${duration}s, Frames: ~${Math.round(duration * parse_slash_number(stream.r_frame_rate))}`);

    // do the actual transcoding
    const code = await transcode(ff_args, x265_args);
    if (code !== 0)
        return console.error(`Transcode failed: ${code}`);
    
    // reinject hdr metadata
    await post_hdr(paths);

    // merge file back together
    const mkv_args = [
        "-o", paths.output,
        "--no-video", paths.input,
        paths.temp
    ];
    await mkvmerge(mkv_args);

    // delete temp file
    await rm(paths.temp)

})();
