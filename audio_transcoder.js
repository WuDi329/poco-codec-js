// import { AUDIO_STREAM_TYPE } from "./pull_demuxer_base.js";
// import { RingBuffer } from "../third_party/ringbufjs/ringbuf.js";

// const DATA_BUFFER_DECODE_TARGET_DURATION = 0.3;
// const DATA_BUFFER_DURATION = 0.6;
// const DECODER_QUEUE_SIZE_MAX = 5;

importScripts('./mp4box.all.min.js');
const ENCODER_QUEUE_SIZE_MAX = 5;
const ENABLE_DEBUG_LOGGING = false;

const VIDEO_STREAM_TYPE = 1;
const AUDIO_STREAM_TYPE = 0;

var framecount = 0;
var chunkCount = 0;
var rechunkCount = 0;

let audioTranscoder = null;

function debugLog(msg) {
  if (!ENABLE_DEBUG_LOGGING) {
    return;
  }
  console.debug(msg);
}

onmessage = async function (e) {
  const msg = e.data;
  console.log('in audio data message...')
  if(audioTranscoder === null)
    audioTranscoder = new AudioTranscoder();
  switch (msg.type) {
    case 'initialize':
      console.log('audio transcoder: case initialize is triggered');
      let demuxer = await import('./mp4_demuxer.js');
      // let audioDemuxer =  new demuxer.MP4PullDemuxer('./newh264.mp4');
      let audioDemuxer =  new demuxer.MP4PullDemuxer();
      let WebmMuxer = await import ('./demo.js');
      let muxer = new WebmMuxer.WebmMuxer();
      //这里可能要重写
      //将提取出几个config的方法单独挪出来，直接将config传入initialize
      console.log('audio transcoder: buffer is')
      console.log(msg.buffer);


      console.log('audio_worker: waiting for encodeconfig')
      const encodeconfig = await audioTranscoder.initialize(audioDemuxer, muxer, msg.buffer);
      console.log('audio_worker: getting encodeconfig')
      console.log("audio transcoder: audioTranscoder initialize finished");
      console.log('initialize done');
      this.self.postMessage({
        type: 'initialize-done',
        workerType : 'audio',
        config: {
          bit_depth: 0,
          sample_rate: encodeconfig.sampleRate,
          channels: encodeconfig.numberOfChannels,
          codec_id: 'A_OPUS'
        }
      });
      break;
    case 'start-transcode':
      //初始调用fillFrameBuffer
      console.log('audio: transcoder is below')
      console.log(audioTranscoder.encoder);
      console.log(audioTranscoder.decoder);
      console.log('audio: transcoder: case start-transcode is triggered');
      audioTranscoder.fillDataBuffer()
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


class AudioTranscoder {
  async initialize(demuxer, muxer, buffer) {
    this.fillInProgress = false;
    this.playing = false;
    this.lock = new SampleLock();
    this.demuxer = demuxer;
    this.muxer = muxer;
    this.overaudio = false;

    // console.log('audio init: buffer is');
    // console.log(buffer)

    console.log('audiotranscoder ready for initialize demuxer')
    await this.demuxer.initialize(AUDIO_STREAM_TYPE, buffer);
    console.log('audiotranscoder finish initialize demuxer')

    this.decoder = new AudioDecoder({
      output: this.bufferAudioData.bind(this),
      error: e => console.error(e)
    });
    // console.log('before audio decode config')
    const decodeconfig = this.demuxer.getDecoderConfig();
    // console.log('audio decodeconfig');
    // console.log(decodeconfig)
    //从decoder获得的sampleRate以及numberOfChannels直接赋给了this
    this.sampleRate = decodeconfig.sampleRate;
    this.channelCount = decodeconfig.numberOfChannels;

    console.log('audio decoder below');
    console.log(this.decoder)
    debugLog(decodeconfig);

    console.assert(AudioDecoder.isConfigSupported(decodeconfig));
    this.decoder.configure(decodeconfig);

    //encoder读取audio data并且将其再次encode
    this.encoder = new AudioEncoder({
      output: this.consumeAudioData.bind(this),
      error: e => console.error(e)
    })
    //当转为webm格式时，音频的config直接写死
    const encodeconfig = {
      codec: 'opus',
      bitrate: 128 * 1000,
      sampleRate: this.sampleRate,
      numberOfChannels: this.channelCount
    }
    console.assert(AudioEncoder.isConfigSupported(encodeconfig));
    this.encoder.configure(encodeconfig);
    return encodeconfig;

    // Initialize the ring buffer between the decoder and the real-time audio
    // rendering thread. The AudioRenderer has buffer space for approximately
    // 500ms of decoded audio ahead.
    //下面这些应该是和播放相关的，暂时先不管了
    // let sampleCountIn500ms =
    //   DATA_BUFFER_DURATION * this.sampleRate * this.channelCount;
    // let sab = RingBuffer.getStorageForCapacity(
    //   sampleCountIn500ms,
    //   Float32Array
    // );
    // this.ringbuffer = new RingBuffer(sab, Float32Array);
    // this.interleavingBuffers = [];

    // this.init_resolver = null;
    // let promise = new Promise(resolver => (this.init_resolver = resolver));

    //  在初始化的过程中调用了fillDataBuffer
    // this.fillDataBuffer();
    // return promise;
  }

  // play() {
  //   // resolves when audio has effectively started: this can take some time if using
  //   // bluetooth, for example.
  //   //play和pause两个函数主要改变playing的状态
  //   debugLog("playback start");
  //   this.playing = true;
  //    在每次点击播放的过程中调用了fillDataBuffer
  //   this.fillDataBuffer();
  // }

  // pause() {
  //   debugLog("playback stop");
  //   this.playing = false;
  // }

  // 作用是确保只有一个能进入这个过程
  async fillDataBuffer() {

    if(this.audioDataFull()){
      console.log('audio data full');
      return;
    }
    // This method is called from multiple places to ensure the buffer stays
    // healthy. Sometimes these calls may overlap, but at any given point only
    // one call is desired.
    if (this.fillInProgress)
      return false;

    this.fillInProgress = true;
    // This should be this file's ONLY call to the *Internal() variant of this method.
    // await this.fillDataBufferInternal();
    
    while (this.decoder.decodeQueueSize < ENCODER_QUEUE_SIZE_MAX && 
      //返回队列中挂起的解码请求数。
        this.encoder.encodeQueueSize < ENCODER_QUEUE_SIZE_MAX && !this.overaudio) {
          
              //由demuxer来控制是否获取下一个chunk
              // console.log('当前的encodequeuesize');
              // console.log(this.encoder.encodeQueueSize)
              // console.log('当前的decodequeuesize');
              // console.log(this.decoder.decodeQueueSize)
      let chunk = await this.demuxer.getNextChunk();

      // console.log('get chunk')
      // console.log(chunk);
      if(!chunk){
        this.overaudio = true; 
      }
      else{ 
        chunkCount++;
        // console.log('chunk data count');
        // console.log(chunkCount);
        this.decoder.decode(chunk);
      }
    }
    // this.fillInProgress = false;
    this.fillInProgress = false;

    if(!this.overaudio && this.encoder.encodeQueueSize === 0)
      setTimeout(this.fillDataBuffer.bind(this), 0);




  }

  audioDataFull(){
    return this.encoder.encodeQueueSize >= ENCODER_QUEUE_SIZE_MAX;
  }

  // async fillAudioData(){


  //   // if (this.fillInProgress) {
  //   //   return false;
  //   // }
  //   // this.fillInProgress = true;

    
  // }

  //这一步是audioDecoder的回调，通过观察控制台输出结果，可以确定的是audio data 和 getNextChunk得到的chunk是一一对应的。
  bufferAudioData(frame) {
    framecount++;
        //暂时去掉
    // console.log('audio data count');
    // console.log(framecount);

    // console.log('audio frame')
    // console.log(frame)
    
    // debugLog(`bufferFrame(${frame.timestamp})`);
    // frameCount ++;
    // console.log(frameCount);
    this.encoder.encode(frame);
    //这里注释了，为了暂停bufferframe
    // this.fillFrameBuffer();
    frame.close();
    // this.frameBuffer.push(frame);
  }



  //要将下面这个函数改写，决定重写了
  // async fillDataBufferInternal() {
  //   debugLog(`fillDataBufferInternal()`);

  //   if (this.audioDataFull()) {
  //     debugLog('\tdecoder saturated');
  //     //// 一些音频解码器会延迟输出直到下一个输入。
  //      // 确保 DECODER_QUEUE_SIZE 足够大，以避免在下面的返回中停滞。 我们依靠解码器输出回调来触发对 fillDataBuffer() 的另一个调用。
  //     // Some audio decoders are known to delay output until the next input.
  //     // Make sure the DECODER_QUEUE_SIZE is big enough to avoid stalling on the
  //     // return below. We're relying on decoder output callback to trigger
  //     // another call to fillDataBuffer().
  //     console.assert(DECODER_QUEUE_SIZE_MAX >= 2);
  //     return;
  //   }


  //   //这里应该也和具体的播放过程相关，尝试先全部注释，如果有问题，再解决
  //   let usedBufferElements = this.ringbuffer.capacity() - this.ringbuffer.available_write();
  //   let usedBufferSecs = usedBufferElements / (this.channelCount * this.sampleRate);
  //   let pcntOfTarget = 100 * usedBufferSecs / DATA_BUFFER_DECODE_TARGET_DURATION;
  //   if (usedBufferSecs >= DATA_BUFFER_DECODE_TARGET_DURATION) {
  //     debugLog(`\taudio buffer full usedBufferSecs: ${usedBufferSecs} pcntOfTarget: ${pcntOfTarget}`);

  //     // When playing, schedule timeout to periodically refill buffer. Don't
  //     // bother scheduling timeout if decoder already saturated. The output
  //     // callback will call us back to keep filling.
  //     if (this.playing)
  //       // Timeout to arrive when buffer is half empty.
  //       //在playing为true的时候，重新调用fillDataBuffer
  //       setTimeout(this.fillDataBuffer.bind(this), 1000 * usedBufferSecs / 2);

  //     // Initialize() is done when the buffer fills for the first time.
  //     if (this.init_resolver) {
  //       this.init_resolver();
  //       this.init_resolver = null;
  //     }

  //     // Buffer full, so no further work to do now.
  //     return;
  //   }

  //   // Decode up to the buffering target or until decoder is saturated.
  //   // 
  //   while (usedBufferSecs < DATA_BUFFER_DECODE_TARGET_DURATION &&
  //     this.decoder.decodeQueueSize < DECODER_QUEUE_SIZE_MAX) {
  //     debugLog(`\tMore samples. usedBufferSecs:${usedBufferSecs} < target:${DATA_BUFFER_DECODE_TARGET_DURATION}.`);
  //     let chunk = await this.demuxer.getNextChunk();
  //     this.decoder.decode(chunk);

  //     // NOTE: awaiting the demuxer.readSample() above will also give the
  //     // decoder output callbacks a chance to run, so we may see usedBufferSecs
  //     // increase.
  //     usedBufferElements = this.ringbuffer.capacity() - this.ringbuffer.available_write();
  //     usedBufferSecs = usedBufferElements / (this.channelCount * this.sampleRate);
  //   }

  //   if (ENABLE_DEBUG_LOGGING) {
  //     let logPrefix = usedBufferSecs >= DATA_BUFFER_DECODE_TARGET_DURATION ?
  //         '\tbuffered enough' : '\tdecoder saturated';
  //     pcntOfTarget = 100 * usedBufferSecs / DATA_BUFFER_DECODE_TARGET_DURATION;
  //     debugLog(logPrefix + `; bufferedSecs:${usedBufferSecs} pcntOfTarget: ${pcntOfTarget}`);
  //   }
  // }

  // bufferHealth() {
  //   return (1 - this.ringbuffer.available_write() / this.ringbuffer.capacity()) * 100;
  // }

  // // From a array of Float32Array containing planar audio data `input`, writes
  // // interleaved audio data to `output`. Start the copy at sample
  // // `inputOffset`: index of the sample to start the copy from
  // // `inputSamplesToCopy`: number of input samples to copy
  // // `output`: a Float32Array to write the samples to
  // // `outputSampleOffset`: an offset in `output` to start writing
  // interleave(inputs, inputOffset, inputSamplesToCopy, output, outputSampleOffset) {
  //   if (inputs.length * inputs[0].length < output.length) {
  //     throw `not enough space in destination (${inputs.length * inputs[0].length} < ${output.length}})`
  //   }
  //   let channelCount = inputs.length;
  //   let outIdx = outputSampleOffset;
  //   let inputIdx = Math.floor(inputOffset / channelCount);
  //   var channel = inputOffset % channelCount;
  //   for (var i = 0; i < inputSamplesToCopy; i++) {
  //     output[outIdx++] = inputs[channel][inputIdx];
  //     if (++channel == inputs.length) {
  //       channel = 0;
  //       inputIdx++;
  //     }
  //   }
  // }

  //这是自己写的encoder的回调，完成encode的过程后会自动给主线程发送信息
  async consumeAudioData(chunk) {






    const data = new ArrayBuffer(chunk.byteLength);
    chunk.copyTo(data);
    self.postMessage({
      type: 'audio-data',
      timestamp: chunk.timestamp,
      duration: chunk.duration,
      is_key: true,
      data
    }, [data])

    await this.lock.status;
    this.lock.lock();
    rechunkCount++;
    this.lock.unlock();

        //暂时去掉
        // console.log('rechunk count');
        // console.log(rechunkCount)

    if(!this.overaudio && this.encoder.encodeQueueSize === 0)
        this.fillDataBuffer();
    if(this.encoder.encodeQueueSize === 0 && this.decoder.decodeQueueSize === 0){
      // console.log(framecount)
      // console.log('audio framecount');
      // console.log(chunkCount);
      // console.log('audio chunkCount');
      if(rechunkCount === 10576){
        self.postMessage({type: 'exit'})
        console.log('current audio')
        console.log('post exit message to self...')
      }
    }
  }

  //这一块是提供的audiodecoder的回调函数，完成decode的过程后应当会自动调用encode
  // bufferAudioData(data) {
  //   if (this.interleavingBuffers.length != data.numberOfChannels) {
  //     this.interleavingBuffers = new Array(this.channelCount);
  //     for (var i = 0; i < this.interleavingBuffers.length; i++) {
  //       this.interleavingBuffers[i] = new Float32Array(data.numberOfFrames);
  //     }
  //   }

  //   debugLog(`bufferAudioData() ts:${data.timestamp} durationSec:${data.duration / 1000000}`);
  //   // Write to temporary planar arrays, and interleave into the ring buffer.
  //   for (var i = 0; i < this.channelCount; i++) {
  //     data.copyTo(this.interleavingBuffers[i], { planeIndex: i });
  //   }
  //   // Write the data to the ring buffer. Because it wraps around, there is
  //   // potentially two copyTo to do.
  //   let wrote = this.ringbuffer.writeCallback(
  //     data.numberOfFrames * data.numberOfChannels,
  //     (first_part, second_part) => {
  //       this.interleave(this.interleavingBuffers, 0, first_part.length, first_part, 0);
  //       this.interleave(this.interleavingBuffers, first_part.length, second_part.length, second_part, 0);
  //     }
  //   );

  //   // FIXME - this could theoretically happen since we're pretty agressive
  //   // about saturating the decoder without knowing the size of the
  //   // AudioData.duration vs ring buffer capacity.
  //   console.assert(wrote == data.numberOfChannels * data.numberOfFrames, 'Buffer full, dropping data!')

  //   // Logging maxBufferHealth below shows we currently max around 73%, so we're
  //   // safe from the assert above *for now*. We should add an overflow buffer
  //   // just to be safe.
  //   // let bufferHealth = this.bufferHealth();
  //   // if (!('maxBufferHealth' in this))
  //   //   this.maxBufferHealth = 0;
  //   // if (bufferHealth > this.maxBufferHealth) {
  //   //   this.maxBufferHealth = bufferHealth;
  //   //   console.log(`new maxBufferHealth:${this.maxBufferHealth}`);
  //   // }

  //   // fillDataBuffer() gives up if too much decode work is queued. Keep trying
  //   // now that we've finished some.
  //   this.fillDataBuffer();
  // }
}
