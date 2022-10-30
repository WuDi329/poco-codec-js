// import { VIDEO_STREAM_TYPE } from "./pull_demuxer_base.js";
// import { MP4PullDemuxer } from "../mp4_pull_demuxer.js";
// import { max_video_config } from "./resolution";

importScripts('./mp4box.all.min.js');

const VIDEO_STREAM_TYPE = 1;
const AUDIO_STREAM_TYPE = 0;
const FRAME_BUFFER_TARGET_SIZE = 3;
const ENABLE_DEBUG_LOGGING = false;
var frameCount = 0;
var framecount = 0;

let videoTranscoder = null;

function debugLog(msg) {
  if (!ENABLE_DEBUG_LOGGING)
    return;
  console.debug(msg);
}

onmessage = async function (e) {
  const msg = e.data;
  if(videoTranscoder === null)
    videoTranscoder = new VideoTranscoder();
  switch (msg.type) {
    case 'initialize':
      console.log('transcoder: case initialize is triggered');
      let demuxer = await import('./mp4_demuxer.js');
      let videoDemuxer =  new demuxer.MP4PullDemuxer('./bbb_video_avc_frag.mp4');
      let WebmMuxer = await import ('./demo.js');
      let muxer = new WebmMuxer.WebmMuxer();
      await videoTranscoder.initialize(videoDemuxer, muxer);
      console.log("transcoder: videoTranscoder initialize finished");
      console.log('initialize done');
      this.self.postMessage({type: 'initialize-done'});
      break;
    case 'start-transcode':
      console.log('transcoder is below')
      console.log(videoTranscoder.encoder);
      console.log(videoTranscoder.decoder);
      console.log('transcoder: case start-transcode is triggered');
      videoTranscoder.fillFrameBuffer()
  }
}


// Controls demuxing and decoding of the video track, as well as rendering
// VideoFrames to canvas. Maintains a buffer of FRAME_BUFFER_TARGET_SIZE
// decoded frames for future rendering.
//控制了解复用和对视频轨道的解码
class VideoTranscoder {
  async initialize(demuxer, muxer) {
    this.frameBuffer = [];
    //是否在fillinprogress，默认是false
    this.fillInProgress = false;

    this.demuxer = demuxer;
    this.muxer = muxer;
    //根据VIDEO_STREAM_TYPE进行初始化，这里进行了demuxer的初始化
    await this.demuxer.initialize(VIDEO_STREAM_TYPE);
    const decodeconfig = this.demuxer.getDecoderConfig();
    const encodeconfig = await this.muxer.getEncoderConfig();
    console.log(decodeconfig);
    console.log(encodeconfig)

    //因为canvas不能传输，而且确实用不到，注释了canvas
    // this.canvas = canvas;
    // this.canvas.width = decodeconfig.displayWidth;
    // this.canvas.height = decodeconfig.displayHeight;
    // this.canvasCtx = canvas.getContext('2d');

    this.decoder = new VideoDecoder({
      //每进来一个frame，将其缓存进frameBuffer中
      output: this.bufferFrame.bind(this),
      error: e => console.error(e),
    });
    console.assert(VideoDecoder.isConfigSupported(decodeconfig))
    this.decoder.configure(decodeconfig);
   
    

    this.init_resolver = null;
    // let promise = new Promise((resolver) => this.init_resolver = resolver );
    //初始化encoder
    this.encoder = new VideoEncoder({
      output: this.consumeFrame.bind(this),
      error: e => console.error(e)
    })
    console.log('encoder is below')
    console.log(this.encoder)
    console.assert(VideoEncoder.isConfigSupported(encodeconfig))
    this.encoder.configure(encodeconfig);
    console.log("decoder & encoder configured finished")
    //初始化之后进行fillFrameBuffer
    //这里先注释
    // this.fillFrameBuffer();
    // console.log("finish fillFrameBuffer")
    // return promise;
  }

  render(timestamp) {
    debugLog('render(%d)', timestamp);
    // let frame = this.chooseFrame(timestamp);
    //每次choose过后，重新填充fillFrameBuffer
    //这里先注释，
    // this.fillFrameBuffer();

    //如果获得的frame是null，代表framebuffer里面没有frame
    if (frame == null) {
      console.warn('VideoRenderer.render(): no frame ');
      return;
    }

    this.paint(frame);
  }

  //传入时间戳，返回距离其时间最近的frame
  chooseFrame(timestamp) {
    if (this.frameBuffer.length == 0)
      return null;

    let minTimeDelta = Number.MAX_VALUE;
    let frameIndex = -1;

    for (let i = 0; i < this.frameBuffer.length; i++) {
      //计算传入的timestamp和buffer中每一个frame的timestamp的绝对值
      let time_delta = Math.abs(timestamp - this.frameBuffer[i].timestamp);
      if (time_delta < minTimeDelta) {
        minTimeDelta = time_delta;
        frameIndex = i;
      } else {
        break;
      }
    }

    //确保不是-1
    console.assert(frameIndex != -1);

    if (frameIndex > 0)
    //丢弃x个陈旧的frame
      debugLog('dropping %d stale frames', frameIndex);

    for (let i = 0; i < frameIndex; i++) {
      //直到frameIndex之前的所有frame都被丢弃，然后close
      let staleFrame = this.frameBuffer.shift();
      staleFrame.close();
    }

    let chosenFrame = this.frameBuffer[0];
    debugLog('frame time delta = %dms (%d vs %d)', minTimeDelta/1000, timestamp, chosenFrame.timestamp)
    return chosenFrame;
  }

  //填充framebuffer
  async fillFrameBuffer() {
    if (this.frameBufferFull()) {
      debugLog('frame buffer full');

      //当init_resolver不为空了
      if (this.init_resolver) {
        //执行init_resolver
        this.init_resolver();
        this.init_resolver = null;
      }

      return;
    }

    // This method can be called from multiple places and we some may already
    // be awaiting a demuxer read (only one read allowed at a time).
    //这个方法可以从多个地方调用，有时可能已经在等待demuxer读取（一次只允许一个读取）。
    //fillinprogress是控制并发的
    if (this.fillInProgress) {
      return false;
    }
    this.fillInProgress = true;

    //当已经buffer的frame和decoded序列长度都小于FRAME_BUFFER_TARGET_SIZE（3）时，就会进行getNextChunk，并且decode
    while (this.decoder.decodeQueueSize < FRAME_BUFFER_TARGET_SIZE && 
      //返回队列中挂起的解码请求数。
        this.encoder.encodeQueueSize < FRAME_BUFFER_TARGET_SIZE) {
              //由demuxer来控制是否获取下一个chunk
              // console.log('当前的encodequeuesize');
              // console.log(this.encoder.encodeQueueSize)
              // console.log('当前的decodequeuesize');
              // console.log(this.decoder.decodeQueueSize)
      let chunk = await this.demuxer.getNextChunk();
      // console.log(chunk);
      this.decoder.decode(chunk);
    }

    this.fillInProgress = false;

    // Give decoder a chance to work, see if we saturated the pipeline.
    //这里是fillframebuffer自己调用自己，也先被我注释了
    setTimeout(this.fillFrameBuffer.bind(this), 0);
  }

  //判断frame是否满
  frameBufferFull() {
    return this.encoder.encodeQueueSize >= FRAME_BUFFER_TARGET_SIZE;
  }

  //将frame buffer起来
  bufferFrame(frame) {
    debugLog(`bufferFrame(${frame.timestamp})`);
    frameCount ++;
    console.log(frameCount);
    this.encoder.encode(frame);
    //这里注释了，为了暂停bufferframe
    // this.fillFrameBuffer();
    frame.close();
    // this.frameBuffer.push(frame);
  }

  consumeFrame(chunk) {
    // framecount++;
    // console.log(framecount);
    //这个chunk的duration属性为0，但是也许可以通过timestamp计算出来？不知道会不会有影响？
    // console.log(chunk);
    const data = new ArrayBuffer(chunk.byteLength);
    chunk.copyTo(data);
    self.postMessage({
      //这里要注意，后面会用type来替代
      type: 'video-data',
      timestamp: chunk.timestamp,
      duration: chunk.duration,
      is_key: chunk.type === 'key',
      data
    }, [data]);
    // console.log(data);
    // console.log(data);
    //data等待处理
  }

  //将frame渲染
  paint(frame) {
    this.canvasCtx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
  }
}
