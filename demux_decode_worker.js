// import { start } from 'repl';


// importScripts('./mp4_demuxer.js');

//不确定这种import方式能不能work，确实不work
// import { WebMWriter } from './webm-writer.js';
// importScripts('./webm-writer.js')

// importScripts('./mp4_demuxer.js')
// importScripts('./mp4box.all.min.js')

let lastMediaTimeCapturePoint = 0;
let lastMediaTimeSecs = 0;
let moduleLoadedResolver = null;
let webmLoadedResolver = null;
let videoTranscoder = null;
let frameCount = 0;
// let playing = false;

//initialize部分的判断条件，只有当它为2时，才返回initialize-done
let workerNum = 0;
let exitNum = 0;

//从worker中读到的Config
let videoConfig = null;
let audioConfig = null;
let modulesReady = new Promise(resolver => (moduleLoadedResolver = resolver));
// 不需要这一步，因为webm是以worker形式导入的。
// let webmReady = new Promise(resolver => (webmLoadedResolver = resolver));

function updateMediaTime(mediaTimeSecs, capturedAtHighResTimestamp) {
  lastMediaTimeSecs = mediaTimeSecs;
  // Translate into Worker's time origin
  lastMediaTimeCapturePoint =
    capturedAtHighResTimestamp - performance.timeOrigin;
}

// Estimate current media time using last given time + offset from now()
function getMediaTimeMicroSeconds() {
  let msecsSinceCapture = performance.now() - lastMediaTimeCapturePoint;
  return ((lastMediaTimeSecs * 1000) + msecsSinceCapture) * 1000;
}

const video_Worker = new Worker('./video_transcoder.js');
const audio_Worker = new Worker('./audio_transcoder.js')
video_Worker.onmessage = passdata
video_Worker.onerror = er => console.error(er);

audio_Worker.onmessage = passdata;
audio_Worker.onerror = er => console.error(er);


function passdata(ev){
  const msg = ev.data;
  switch (msg.type) {
    case 'initialize-done':
      // console.log('demux_worker:get transcoder done')
      if(msg.workerType === 'video')
        videoConfig = msg.config;
      else
        audioConfig = msg.config;
        //这里先不加入音频
      // console.log('videoconfig')
      // console.log(videoConfig)
      // console.log(workerNum);
      
      //妥协的产物：暂时注释audio部分
      // self.postMessage({
      //   type: 'initialize-done',
      //   webm_stats_interval: 1000,
      //   webm_metadata: {
      //     max_cluster_duration: BigInt(2000000000),
      //     video: videoConfig,
      //   }});
      if(++workerNum === 2){
        console.log('in demux worker')
        console.log(videoConfig);
        console.log(audioConfig)
      self.postMessage({
        type: 'initialize-done',
        webm_stats_interval: 1000,
        webm_metadata: {
          max_cluster_duration: BigInt(2000000000),
          video: videoConfig,
          audio: audioConfig
        }});
      }
      break;
    case 'error':
      self.postMessage({
        type: 'error',
        err: msg.err
      })
      break;
    case 'exit':
      console.log('decode worker: get exit from a transcoder');
      if(++exitNum == 2){
        video_Worker.terminate();
        audio_Worker.terminate();
        self.postMessage(msg);
      }
      break;
    default:
      self.postMessage(msg, [msg.data])
      break;
  }

}

//这里一整块的作用是创建videotranscoder，由于下面已经再worker中尝试创建，所以这里先注释了
// (async () => {
//   let videoImport = import('./video_transcoder.js');
//   videoImport.then((vi) =>{
//     videoTranscoder = new vi.VideoTranscoder();
//     console.log(videoTranscoder);
//     moduleLoadedResolver();
//     moduleLoadedResolver = null;
//     console.log('worker imported')
//   });
  
// })();

self.addEventListener('message', async function(e) {
  // await modulesReady;
  const msg = e.data;
  switch (msg.type) {
    case 'initialize':
      //在transcoder中执行initialize
      //为了测试天线宝宝，先把audio注释
      console.log('demux worker: buffer is');
      console.log(msg.buffer)
      // const source = new MP4Source(msg.buffer)
      const buffer = msg.buffer
      video_Worker.postMessage({
        type: 'initialize',
        // source: source
        buffer: msg.buffer
      });
      //可以考虑提高性能：msg.buffer这里需要进行深度拷贝一次
      audio_Worker.postMessage({
        type: 'initialize',
        // source: source
        buffer: msg.buffer
      }, [msg.buffer])
      // let videoReady = videoTranscoder.initialize(videoDemuxer, e.data.canvas, muxer);
      // await videoReady;
      console.log("demux_worker: videoTranscoder initialize begin")
      console.log("demux_worker: audioTranscoder initialize begin")
      // console.log('initialize done');
      // this.postMessage({command: 'initialize-done'})
      break;
    case 'start-transcode':
      //这里目前只有一个video_worker，还有一个audio_worker等待添加
      video_Worker.postMessage({
        type: 'start-transcode'
      });
      ////为了测试天线宝宝，先把audio注释
      audio_Worker.postMessage({
        type: 'start-transcode'
      })
      break;
    // case 'terminate':
    //   console.log('decode-worker: terminate触发');
    //   // video_Worker.terminate();
    //   // audio_Worker.terminate()
    //   //这里先注释，理由同上
    //   // audio_Worker.terminate();    
    //   this.self.postMessage('terminate');
    //   break;
    // 目前不需要这些其他情况
    // case 'play':
    //   playing = true;
    //   updateMediaTime(e.data.mediaTimeSecs,
    //                   e.data.mediaTimeCapturedAtHighResTimestamp);
      
    //   self.requestAnimationFrame(function renderVideo() {
    //   //如果playing是false，那么将会直接返回
    //     if (!playing)
    //       return;
    //       //根据getMediaTimeMicroSeconds()返回的时间，返回具体的frame
    //       videoTranscoder.render(getMediaTimeMicroSeconds());
    //     self.requestAnimationFrame(renderVideo);
    //   });
    //   break;
    // case 'pause':
    //   playing = false;
    //   break;
    // case 'update-media-time':
    //   updateMediaTime(e.data.mediaTimeSecs,
    //                   e.data.mediaTimeCapturedAtHighResTimestamp);
    //   break;
    default:
      console.error(`Worker bad message: ${e.data}`);
  }
})
