// import { VIDEO_STREAM_TYPE } from "./pull_demuxer_base.js";
// import { MP4PullDemuxer } from "../mp4_pull_demuxer.js";
// import { max_video_config } from "./resolution";

importScripts('./mp4box.all.min.js');

const VIDEO_STREAM_TYPE = 1;
const AUDIO_STREAM_TYPE = 0;
const FRAME_BUFFER_TARGET_SIZE = 5;
const ENABLE_DEBUG_LOGGING = false;
var framecount = 0;
var chunkCount = 0;
var rechunkCount = 0;

let videoTranscoder = null;

function debugLog(msg) {
  if (!ENABLE_DEBUG_LOGGING)
    return;
  console.debug(msg);
}

const vp9_params = {
  profile: 0,
  level: 10,
  bit_depth: 8,
  // chroma_subsampling: chroma_el.value ? 2 : 1
  chroma_subsampling: 1
};

onmessage = async function (e) {
  const msg = e.data;
  if(videoTranscoder === null)
    videoTranscoder = new VideoTranscoder();
  switch (msg.type) {
    case 'initialize':
      console.log('video transcoder: case initialize is triggered');
      let demuxer = await import('./mp4_demuxer.js');
      // let videoDemuxer =  new demuxer.MP4PullDemuxer('./ljh264.mp4');
      //这里不传入文件名字了
      let videoDemuxer =  new demuxer.MP4PullDemuxer();
      let WebmMuxer = await import ('./demo.js');
      let muxer = new WebmMuxer.WebmMuxer();

      // console.log('video transcoder: buffer is')
      // console.log(msg.buffer);

      //这里可能要重写
      //将提取出几个config的方法单独挪出来，直接将config传入initialize
      const encodeconfig = await videoTranscoder.initialize(videoDemuxer, muxer, msg.buffer);
      console.log("video transcoder: Transcoder initialize finished");
      console.log('video transcoder: initialize done');
      this.self.postMessage({
        type: 'initialize-done',
        workerType : 'video',
        config: {
          width: encodeconfig.width,
          height: encodeconfig.height,
          frame_rate: encodeconfig.framerate,
          // codec_id: encodeconfig.codec,
          codec_id: 'V_VP9',
          ...vp9_params
        }
      });
      break;
    case 'start-transcode':
      //初始调用fillFrameBuffer
      console.log('video transcoder is below')
      console.log(videoTranscoder.encoder);
      console.log(videoTranscoder.decoder);
      console.log('video transcoder: case start-transcode is triggered');
      videoTranscoder.fillFrameBuffer()
      break;
  }
}

class SampleLock{
  constructor(){
    this.callback = null;
    this.status = new Promise((resolve) => resolve(true));
    this.lock = function(){
      this.status = new Promise((resolve) => {this.callback = resolve})
      // console.log('locked')
    }
    this.unlock = function(){
      this.callback(true)
    }
  }
}


// Controls demuxing and decoding of the video track, as well as rendering
// VideoFrames to canvas. Maintains a buffer of FRAME_BUFFER_TARGET_SIZE
// decoded frames for future rendering.
//控制了解复用和对视频轨道的解码
class VideoTranscoder {
  async initialize(demuxer, muxer, buffer) {
    this.frameBuffer = [];
    //是否在fillinprogress，默认是false
    this.fillInProgress = false;
    // this.addProcess = false;

    this.demuxer = demuxer;
    this.muxer = muxer;
    this.over = false;

    this.lock = new SampleLock();

    // console.log('video init: buffer is');
    // console.log(buffer);
    //根据VIDEO_STREAM_TYPE进行初始化，这里进行了demuxer的初始化
    //感觉这个buffer也许应该在demux_worker就搞定了
    
    await this.demuxer.initialize(VIDEO_STREAM_TYPE, buffer);
    const decodeconfig = this.demuxer.getDecoderConfig();
    const encodeconfig = await this.muxer.getEncoderConfig();
    // console.log(decodeconfig);
    console.log('encodeconfig');
    console.log(encodeconfig)



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
    // console.log("decoder & encoder configured finished")
    //要将相关参数返回去，这里return
    return encodeconfig;
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

  //填充framebuffer
  async fillFrameBuffer() {
    if (this.frameBufferFull()) {
      console.log('video frame buffer full');

      //当init_resolver不为空了
      //这里应该变不了，注意这里改了，如果报错了再把这里调整一下
      // if (this.init_resolver) {
      //   //执行init_resolver
      //   this.init_resolver();
      //   this.init_resolver = null;
      // }

      setTimeout(this.fillFrameBuffer.bind(this), 20);
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
        this.encoder.encodeQueueSize < FRAME_BUFFER_TARGET_SIZE && !this.over) {
          
              //由demuxer来控制是否获取下一个chunk
              // console.log('当前的encodequeuesize');
              // console.log(this.encoder.encodeQueueSize)
              // console.log('当前的decodequeuesize');
              // console.log(this.decoder.decodeQueueSize)
      let chunk = await this.demuxer.getNextChunk();

      // console.log('get chunk')
      // console.log(chunk);
      if(!chunk){
        this.over = true; 
      }
      else{ 
        chunkCount++;
        // console.log("onsamples : video encodedframe number is "+ chunkCount)
        this.decoder.decode(chunk);
      }
    }
    this.fillInProgress = false;

    

    // Give decoder a chance to work, see if we saturated the pipeline.
    //这里是fillframebuffer自己调用自己，也先被我注释了
    if(!this.over && this.encoder.encodeQueueSize === 0)
      setTimeout(this.fillFrameBuffer.bind(this), 0);
  }

  //判断frame是否满
  frameBufferFull() {
    return this.encoder.encodeQueueSize >= FRAME_BUFFER_TARGET_SIZE;
  }

  //将frame buffer起来
async   bufferFrame(frame) {
    await this.lock.status;
    this.lock.lock();
    framecount++;
    this.lock.unlock();
    // console.log('framecount is '+ framecount)
    // console.log('after decode, videoframe timestamp is '+ frame.timestamp)
    // debugLog(`bufferFrame(${frame.timestamp})`);
    this.encoder.encode(frame);
    //这里注释了，为了暂停bufferframe
    // this.fillFrameBuffer();
    frame.close();
    // this.frameBuffer.push(frame);
  }

  //有没有什么办法记录最后一个frame呢
  async consumeFrame(chunk) {
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

    await this.lock.status;
    this.lock.lock();
    rechunkCount++;
    this.lock.unlock();
    // console.log("rechunk count is"+ rechunkCount)
    // console.log('after encode, current rechunk timestamp is '+ chunk.timestamp)
    
    
    //调用的主要地方，consumeFrame处
    if(!this.over && this.encoder.encodeQueueSize === 0)
        this.fillFrameBuffer();
    
    if(this.encoder.encodeQueueSize === 0 && this.decoder.decodeQueueSize === 0 && this.over){
      // console.log(framecount)
      // console.log('video framecount');
      // console.log(chunkCount);
      // console.log('video chunkCount');

      //这里以下先进行注释，主要是为了看总共有多少个frame
      if(framecount === chunkCount-1){
        console.log('current video')
        console.log(framecount)
        console.log(chunkCount)
        console.log('post exit message to self...')
        console.log(framecount)
        self.postMessage({type: 'exit'})
      }
    }
    // console.log(data);
    // console.log(data);
    //data等待处理
  }

  //将frame渲染
  paint(frame) {
    this.canvasCtx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
  }
}
