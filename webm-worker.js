// metadata flags
const video_flag = 0b01;
const audio_flag = 0b10;

// header flags
const video_type_flag  = 0b001;
const key_flag         = 0b010;
const new_cluster_flag = 0b100;

const max_timestamp_mismatch_warnings = 10;

function onerror(e) {
    console.error(e);
    self.postMessage({
        type: 'error',
        detail: e.message
    });
}

let metadata;
let options;
let webm_muxer;
let first_video_timestamp = null;
let first_audio_timestamp = null; // using timestamps on encoded chunks
let next_audio_timestamp = 0; // using durations on encoded chunks
let last_timestamp = -1;
let last_video_in_timestamp = 0;
let last_video_out_timestamp = 0;
let last_audio_in_timestamp = 0;
let last_audio_out_timestamp = 0;
let audio_msgs_since_last_cluster = 0;
let queued_video = [];
let queued_audio = [];
let num_timestamp_mismatch_warnings = 0;

//第六步，webm_worker发送stream-data给webm_muxer
function send_data(data) {
    
    // console.log('webm_worker: 发送stream-data给webm-muxer')
    webm_muxer.postMessage({
        type: 'stream-data',
        data
    }, [data]);
}

function send_msg(msg) {
    if (msg.timestamp <= last_timestamp)  {
        if (msg.timestamp < last_timestamp) {
            console.warn(`${msg.type} timestamp ${msg.timestamp} is older than last timestamp ${last_timestamp}`);
        }
        msg.timestamp = last_timestamp + 1;
    }
    last_timestamp = msg.timestamp;

    const header = new ArrayBuffer(1);
    //告诉webm_muxer这是什么数据（只有video-data会特殊标记）
    new DataView(header).setUint8(0,
        (msg.type === 'video-data' ? video_type_flag : 0) |
        (msg.is_key ? key_flag : 0) |
        (msg.new_cluster ? new_cluster_flag : 0),
        true);

    const timestamp = new ArrayBuffer(8);
    new DataView(timestamp).setBigUint64(0, BigInt(msg.timestamp), true);

    const duration = new ArrayBuffer(8);
    new DataView(duration).setBigUint64(0, BigInt(msg.duration || 0), true);
        // console.log('send header to webm_muxer')
    send_data(header);
    // console.log('send timestamp to webm_muxer')
    send_data(timestamp);
    // console.log('send duration to webm_muxer')
    send_data(duration);
    // console.log('send msg.data to webm_muxer')
    send_data(msg.data);
}

function get_video_ts(vmsg) {
    const vtimestamp = last_video_out_timestamp + (vmsg.timestamp - last_video_in_timestamp);
    if (vtimestamp <= last_timestamp) {
        if (vtimestamp < last_timestamp) {
            console.warn(`video timestamp ${vtimestamp} is older than last timestamp ${last_timestamp}`);
        }
        return last_timestamp + 1;
    }
    return vtimestamp;
}

function set_video_ts(vmsg, vtimestamp) {
    last_video_in_timestamp = vmsg.timestamp;
    vmsg.timestamp = vtimestamp;
    last_video_out_timestamp = vtimestamp;
    return vmsg;
}

function get_audio_ts(amsg) {
    const atimestamp = last_audio_out_timestamp + (amsg.timestamp - last_audio_in_timestamp);
    if (atimestamp <= last_timestamp) {
        if (atimestamp < last_timestamp) {
            console.warn(`audio timestamp ${atimestamp} is older than last timestamp ${last_timestamp}`);
        }
        return last_timestamp + 1;
    }
    return atimestamp;
}

function set_audio_ts(amsg, atimestamp) {
    last_audio_in_timestamp = amsg.timestamp;
    amsg.timestamp = atimestamp;
    last_audio_out_timestamp = atimestamp;
    return amsg;
}

//send_msgs调用以上所有的方法
function send_msgs(opts) {
    //如果metadata.video是空，调用
    if (!metadata.video) {
        while (queued_audio.length > 0) {
            //将queued_audio的前几位全部发送出去
            send_msg(queued_audio.shift());
        }
        return;
    }

    if (!metadata.audio) {
        while (queued_video.length > 0) {
            //将queued_video的前几位全部发送出去
            send_msg(queued_video.shift());
        }
        return;
    }

    //当这两个queue里有东西的时候执行
    while ((queued_video.length > 0) && (queued_audio.length > 0)) {
        //分别获取video和audip的timestamp（时间戳
        const vtimestamp = get_video_ts(queued_video[0]);
        const atimestamp = get_audio_ts(queued_audio[0]);

        //根据video和audio的顺序决定先发谁
        if (vtimestamp < atimestamp) {
            send_msg(set_video_ts(queued_video.shift(), vtimestamp));
        } else {
            send_msg(set_audio_ts(queued_audio.shift(), atimestamp));
        }
    }

    //当有一边彻底清0，并且queued_video.length > opts.video_queue_limit
    while (queued_video.length > opts.video_queue_limit) {
        const msg = queued_video.shift();
        const vtimestamp = get_video_ts(msg);
        send_msg(set_video_ts(msg, vtimestamp));
    }

    while (queued_audio.length > opts.audio_queue_limit) {
        const msg = queued_audio.shift();
        if ((queued_audio.length === opts.audio_queue_limit) &&
            (++audio_msgs_since_last_cluster > opts.audio_queue_limit)) {
            msg.new_cluster = true;
            audio_msgs_since_last_cluster = 0;
        }
        const atimestamp = get_audio_ts(msg);
        send_msg(set_audio_ts(msg, atimestamp));
    }
}

//第五步的下属步骤：从metadata中提取信息发送给webm_muxer
function send_metadata(metadata) {
    const max_cluster_duration = new ArrayBuffer(8);
    new DataView(max_cluster_duration).setBigUint64(0, metadata.max_cluster_duration || BigInt(0), true);;
    send_data(max_cluster_duration);

    const flags = new ArrayBuffer(1);
    new DataView(flags).setUint8(0,
        (metadata.video ? video_flag : 0) |
        (metadata.audio ? audio_flag : 0),
        true);
    send_data(flags);

    if (metadata.video) {
        const width = new ArrayBuffer(4);
        new DataView(width).setInt32(0, metadata.video.width, true);
        send_data(width);

        const height = new ArrayBuffer(4);
        new DataView(height).setInt32(0, metadata.video.height, true);
        send_data(height);

        const frame_rate = new ArrayBuffer(4);
        new DataView(frame_rate).setFloat32(0, metadata.video.frame_rate || 0, true);
        send_data(frame_rate);

        send_data(new TextEncoder().encode(metadata.video.codec_id).buffer);

        if (metadata.video.codec_id === 'V_VP9') {
            // See https://www.webmproject.org/docs/container/#vp9-codec-feature-metadata-codecprivate
            const codec_private = new ArrayBuffer(12);
            const view = new DataView(codec_private);
            view.setUint8(0, 1); // profile
            view.setUint8(1, 1); // length
            view.setUint8(2, metadata.video.profile || 0);
            view.setUint8(3, 2); // level
            view.setUint8(4, 1); // length
            view.setUint8(5, metadata.video.level || 10);
            view.setUint8(6, 3); // bit depth
            view.setUint8(7, 1); // length
            view.setUint8(8, metadata.video.bit_depth || 8);
            view.setUint8(9, 4); // chroma subsampling
            view.setUint8(10, 1); // length
            view.setUint8(11, metadata.video.chroma_subsampling || 1);
            send_data(codec_private);
        } else if (metadata.video.codec_id === 'V_AV1') {
            // See https://github.com/ietf-wg-cellar/matroska-specification/blob/master/codec/av1.md#codecprivate-1
            const codec_private = new ArrayBuffer(4);
            const view = new DataView(codec_private);
            view.setUint8(0, 0b10000001); // marker and version
            view.setUint8(1, metadata.video.profile << 5 |
                             metadata.video.level);
            view.setUint8(2, metadata.video.tier << 7 |
                             metadata.video.high_bitdepth << 6 |
                             metadata.video.twelve_bit << 5 |
                             metadata.video.monochrome << 4 |
                             metadata.video.chroma_subsampling_x << 3 |
                             metadata.video.chroma_subsampling_y << 2 |
                             metadata.video.chroma_sample_position);
            // leave byte 3 (initial_presentation_delay_*) as 0
            send_data(codec_private);
        } else {
            send_data(new ArrayBuffer(0));
        }

        const seek_pre_roll = new ArrayBuffer(8);
        new DataView(seek_pre_roll).setBigUint64(0, metadata.video.seek_pre_roll || BigInt(0), true);
        send_data(seek_pre_roll);
    }

    if (metadata.audio) {
        const sample_rate = new ArrayBuffer(4);
        new DataView(sample_rate).setInt32(0, metadata.audio.sample_rate, true);
        send_data(sample_rate);

        const channels = new ArrayBuffer(4);
        new DataView(channels).setInt32(0, metadata.audio.channels, true);
        send_data(channels);

        const bit_depth = new ArrayBuffer(4);
        new DataView(bit_depth).setInt32(0, metadata.audio.bit_depth || 0, true);
        send_data(bit_depth);

        send_data(new TextEncoder().encode(metadata.audio.codec_id).buffer);

        if (metadata.audio.codec_id === 'A_OPUS') {
            // Adapted from https://github.com/kbumsik/opus-media-recorder/blob/master/src/ContainerInterface.cpp#L27
            // See also https://datatracker.ietf.org/doc/html/rfc7845#section-5.1

            const codec_private = new ArrayBuffer(19);
            new TextEncoder().encodeInto('OpusHead', new Uint8Array(codec_private)); // magic

            const view = new DataView(codec_private);
            view.setUint8(8, 1); // version
            view.setUint8(9, metadata.audio.channels); // channel count
            view.setUint16(10, metadata.audio.pre_skip || 0, true); // pre-skip
            view.setUint32(12, metadata.audio.sample_rate, true); // sample rate
            view.setUint16(16, metadata.audio.output_gain || 0, true); // output gain
            view.setUint8(18, 0, true); // mapping family

            send_data(codec_private);
        } else {
            send_data(new ArrayBuffer(0));
        }

        const seek_pre_roll = new ArrayBuffer(8);
        new DataView(seek_pre_roll).setBigUint64(0,
                metadata.audio.seek_pre_roll || BigInt(metadata.audio.codec_id === 'A_OPUS' ? 80000 : 0),
                true);
        send_data(seek_pre_roll);
    }

    //第七步：webm_worker发送start-stream给webm_muxer
    self.postMessage({type: 'start-stream'});
}

onmessage = function (e) {
    const msg = e.data;
    switch (msg.type) {
        case 'video-data':
            ////第12步：接收到主线程转发的audio-data之后，对他进行进一步处理
            // console.log('webme-worker: case video-data is triggered')
            //如果metadata已经存在
            if (metadata.video) {
                if (first_video_timestamp === null) {
                    first_video_timestamp = msg.timestamp;
                }
                msg.timestamp -= first_video_timestamp;
                queued_video.push(msg);
                send_msgs(options);
            }
            break;

            //第12步：接收到主线程转发的audio-data之后，对他进行进一步处理
        case 'audio-data':
            console.log('webme-worker: case audio-data is triggered')
            if (metadata.audio) {
                if (first_audio_timestamp === null) {
                    first_audio_timestamp = msg.timestamp;
                }
                const timestamp = msg.timestamp - first_audio_timestamp;
                if (!msg.duration && (next_audio_timestamp >= 0)) {
                    console.warn('no audio duration');
                    next_audio_timestamp = -1;
                }
                if (next_audio_timestamp >= 0) {
                    msg.timestamp = next_audio_timestamp;
                    next_audio_timestamp += msg.duration;
                    if ((msg.timestamp !== timestamp) &&
                        (++num_timestamp_mismatch_warnings <= max_timestamp_mismatch_warnings)) {
                        console.warn(`timestamp mismatch: timestamp=${timestamp} durations=${msg.timestamp}`);
                        if (num_timestamp_mismatch_warnings === max_timestamp_mismatch_warnings) {
                            console.warn('supressing further timestamp mismatch warnings');
                        }
                    }
                } else {
                    msg.timestamp = timestamp;
                }
                queued_audio.push(msg);
                send_msgs(options);
            }
            break;

            //主线程发送start时，这里被触发
        case 'start': {
            //第2步：收到start的响应
            console.log('webme-worker: case start is triggered')
            //metadata来自于主线程的webm_meatadata
            metadata = msg.webm_metadata;
            options = {
                video_queue_limit: Infinity,
                audio_queue_limit: Infinity,
                use_audio_timestamps: false,
                ...msg.webm_options
            };
            delete msg.webm_metadata;
            delete msg.webm_options;

            if (options.use_audio_timestamps) {
                next_audio_timestamp = -1;
            }

            //new webm-muxer.js
            webm_muxer = new Worker('./webm-muxer.js');
            webm_muxer.onerror = onerror;

            //listen to webm-muxer.js
            webm_muxer.onmessage = function (e) {
                const msg2 = e.data;
                switch (msg2.type) {
                    //main thread msg:type=start
                    case 'ready':
                        //第三步：webm_worker监听到webm_muxer发送的ready消息
                        console.log('webm-worker: case ready is triggered')
                        //第四步：webm_worker将主线程的msg发送给webm_muxer，msg的type为start
                        // console.log(msg)
                        webm_muxer.postMessage(msg);
                        break;

                    //send data to webm-muxer msg:stream-data
                    case 'start-stream':
                        //第五步：webm_worker监听到webm_muxer发送的start-stream
                        console.log('webm-worker: case start-stream is triggered')
                        send_metadata(metadata);
                        break;

                    //forward the message about exit
                    case 'exit':
                        console.log('webm-worker: case exit is triggered')
                        webm_muxer.terminate();
                        self.postMessage(msg2);
                        break;

                    ///forward the message about muxed-data

                    //很多步之后，获得了muxed-data
                    case 'muxed-data':
                        console.log('webm-worker: case muxed-data is triggered')
                        //将muxed-data发送给主线程
                        self.postMessage(msg2, [msg2.data]);
                        break;

                    ///forward the message about stats
                    case 'stats':
                        // console.log('webm-worker: case stats is triggered')
                        self.postMessage(msg2);
                        break;
                    //?
                    default:
                        self.postMessage(msg2, msg2.transfer);
                        break;
                }
            };

            break;
        }

        case 'end': {
            console.log('webme-worker: case end is triggered')
            if (webm_muxer) {
                if (queued_audio.length > 0) {
                    queued_audio[0].new_cluster = true;
                }
                send_msgs({ video_queue_limit: 0, audio_queue_limit: 0 });
                webm_muxer.postMessage(msg);
            }
            break;
        }
    }
};
