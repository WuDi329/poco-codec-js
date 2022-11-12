const VIDEO_STREAM_TYPE = 1;
const AUDIO_STREAM_TYPE = 0;

//添加ENABLE_DEBUG_LOGGING
const ENABLE_DEBUG_LOGGING = false;

class PullDemuxerBase {
  
  // Starts fetching file. Resolves when enough of the file is fetched/parsed to
  // populate getDecoderConfig().
  async initialize(streamType) {}

  // Returns either an AudioDecoderConfig or VideoDecoderConfig based on the
  // streamType passed to initialize().
  getDecoderConfig() {}

  // Returns either EncodedAudioChunks or EncodedVideoChunks based on the
  // streamType passed to initialize(). Returns null after EOF.
  async getNextChunk() {}
}

export class MP4PullDemuxer extends PullDemuxerBase {
  constructor(fileUri) {
    super();
    if(fileUri)
    this.fileUri = fileUri;
  }

  async initialize(streamType, buffer) {
    console.log('mp4 demuxer init: buffer is');
    console.log(buffer);
    // this.buffer = buffer;
    // console.log('this.fileUri')
    // console.log(this.fileUri)
    //这里是利用buffer创建了source，也许是
    this.source = new MP4Source(buffer);
    // console.log(streamType);
    console.log('mp4 demuxer: finish source')

    this.readySamples = [];
    this.over = false;
    this._pending_read_resolver = null;
    this.streamType = streamType;

    
    if(streamType === 0)
      console.log('audio ready for tracks')

    //不管是videotrack还是audiotrack都ready了
    await this._tracksReady();

    if(streamType === 0)
      console.log('audio finished tracks')

    if (this.streamType == AUDIO_STREAM_TYPE) {
      this._selectTrack(this.audioTrack);
    } else {
      this._selectTrack(this.videoTrack);
    }
    // console.log('demuxer initialize finished')
  }

  getDecoderConfig() {
    //判断当前流类型
    if (this.streamType == AUDIO_STREAM_TYPE) {
      console.log('in audio config ')
      console.log(this.audioTrack.codec)
      console.log(this.audioTrack.audio.sample_rate)
      console.log(this.audioTrack.audio.channel_count)
      console.log(this.source.getAudioSpecificConfig())
      return {
        codec: this.audioTrack.codec,
        sampleRate: this.audioTrack.audio.sample_rate,
        numberOfChannels: this.audioTrack.audio.channel_count,
        description: this.source.getAudioSpecificConfig()
      };
    } else {
      return {
        codec: this.videoTrack.codec,
        displayWidth: this.videoTrack.track_width,
        displayHeight: this.videoTrack.track_height,
        description: this._getAvcDescription(this.source.getAvccBox())
      }
    }
  }

  async getNextChunk() {
    //第一步：直接请求getNextChunk
    // console.log(this.over)
    //这里先注释，搞清楚为什么第一帧不见了

      let sample = await this._readSample();
      if(sample !== null){
        const type = sample.is_sync ? "key" : "delta";
        const pts_us = (sample.cts * 1000000) / sample.timescale;
        const duration_us = (sample.duration * 1000000) / sample.timescale;
        const ChunkType = this.streamType == AUDIO_STREAM_TYPE ? EncodedAudioChunk : EncodedVideoChunk;
        return new ChunkType({
          type: type,
          timestamp: pts_us,
          duration: duration_us,
          data: sample.data
        });
    }else
      return null;
  }

  _getAvcDescription(avccBox) {
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    avccBox.write(stream);
    return new Uint8Array(stream.buffer, 8);  // Remove the box header.
  }

  async _tracksReady() {
    console.log('start of tracksready, source is')
    console.log(this.source);
    let info = await this.source.getInfo();
    this.videoTrack = info.videoTracks[0];
    console.log('in tracksready');
    console.log(info);
    this.audioTrack = info.audioTracks[0];
  }

  _selectTrack(track) {
    console.assert(!this.selectedTrack, "changing tracks is not implemented");
    this.selectedTrack = track;
    this.source.selectTrack(track);
  }

  async _readSample() {
    //第二步：从_readSample获取
    console.assert(this.selectedTrack);
    console.assert(!this._pending_read_resolver);

    //如果readySample.length不为0，就返回
    if (this.readySamples.length) {
      return Promise.resolve(this.readySamples.shift());
    }
    //如果readySample.length为0，就再去上一层寻找
    console.log('_pending_read_resolver....')
    console.log('this.over')
    console.log(this.over);

    let promise = new Promise((resolver) => { this._pending_read_resolver = resolver; });
    // console.log('this._pending_read_resolver');
    // console.log(this._pending_read_resolver);
    
    console.assert(this._pending_read_resolver);

    //bind() 方法创建一个新的函数，在 bind() 被调用时，这个新函数的 this 被指定为 bind() 的第一个参数，而其余参数将作为新函数的参数，供调用时使用。
    if(!this.over){
      this.source.start(this._onSamples.bind(this));
    }else{
      this._pending_read_resolver(null);
      this._pending_read_resolver = null;
    }
    return promise;
  }

  _onSamples(samples) {
    
    // debugger;
    const SAMPLE_BUFFER_TARGET_SIZE = 50;

    if(samples.length < 1000) {
      this.over = true;
      console.log('已经取完全部samples了')
    }
      console.log('samples长度大于0')
      this.readySamples.push(...samples);
      if (this.readySamples.length >= SAMPLE_BUFFER_TARGET_SIZE)
        this.source.stop();

      let firstSampleTime = samples[0].cts * 1000000 / samples[0].timescale ;
      console.log(`adding new ${samples.length} samples (first = ${firstSampleTime}). total = ${this.readySamples.length}`);

      if (this._pending_read_resolver) {
        const current = this.readySamples.shift();
        // console.log(current)
        this._pending_read_resolver(current);
        this._pending_read_resolver = null;
      }
    }
  
}

class MP4Source {

  constructor(buffer){
    this.file = MP4Box.createFile();
    this.file.onError = console.error.bind(console);
    this.file.onReady = this.onReady.bind(this);
    this.file.onSamples = this.onSamples.bind(this);
    // const file = new Blob([buffer], "video/mp4")
    console.log('mp4 source: buffer is')
    console.log(buffer)
    const blob = new Blob([buffer]);
    const reader = blob.stream().getReader();
    let offset = 0;
    let mp4File = this.file;

    function appendBuffers({done, value}) {
      if(done) {
        mp4File.flush();
        return;
      }

      let buf = value.buffer;
      buf.fileStart = offset;

      offset += buf.byteLength;

      mp4File.appendBuffer(buf);

      return reader.read().then(appendBuffers);
    }

    reader.read().then(appendBuffers);
    console.log('mp4file is ...')
    console.log(mp4File)

    this.info = null;
    this._info_resolver = null;
  }


  //这里的constructor先注释，为了保证只跑上面的部分
  // constructor(uri) {

  //   this.file = MP4Box.createFile();
  //   console.log('uri')
  //   // console.log(uri)
  //   this.file.onError = console.error.bind(console);
  //   this.file.onReady = this.onReady.bind(this);
  //   this.file.onSamples = this.onSamples.bind(this);


  //   debugLog('fetching file');
  //   fetch(uri).then(response => {
  //     debugLog('fetch responded');
  //     const reader = response.body.getReader();
  //     let offset = 0;
  //     let mp4File = this.file;

  //     function appendBuffers({done, value}) {
  //       if(done) {
  //         mp4File.flush();
  //         return;
  //       }

  //       let buf = value.buffer;
  //       buf.fileStart = offset;

  //       offset += buf.byteLength;

  //       mp4File.appendBuffer(buf);

  //       return reader.read().then(appendBuffers);
  //     }

  //     return reader.read().then(appendBuffers);
  //   })

  //   this.info = null;
  //   this._info_resolver = null;
  // }

  onReady(info) {
    // TODO: Generate configuration changes.
    this.info = info;

    if (this._info_resolver) {
      this._info_resolver(info);
      this._info_resolver = null;
    }
  }

  selectTrack(track) {
    debugLog('selecting track %d', track.id);
    this.file.setExtractionOptions(track.id);
  }

  getInfo() {
    if (this.info)
      return Promise.resolve(this.info);

    return new Promise((resolver) => { this._info_resolver = resolver; });
  }

  getHvccBox() {
    // TODO: make sure this is coming from the right track.
    console.log(this.file.moov.traks[0].mdia.minf.stbl.stsd.entries[0].hvcC)
    return this.file.moov.traks[0].mdia.minf.stbl.stsd.entries[0].hvcC
  }

  getAvccBox() {
    // TODO: make sure this is coming from the right track.
    return this.file.moov.traks[0].mdia.minf.stbl.stsd.entries[0].avcC
  }

  getAudioSpecificConfig() {

    // console.log(this.file.moov.traks[0]);
    // TODO: make sure this is coming from the right track.

    // 0x04 is the DecoderConfigDescrTag. Assuming MP4Box always puts this at position 0.
    console.assert(this.file.moov.traks[1].mdia.minf.stbl.stsd.entries[0].esds.esd.descs[0].tag == 0x04);
    // 0x40 is the Audio OTI, per table 5 of ISO 14496-1
    console.assert(this.file.moov.traks[1].mdia.minf.stbl.stsd.entries[0].esds.esd.descs[0].oti == 0x40);
    // 0x05 is the DecSpecificInfoTag
    console.assert(this.file.moov.traks[1].mdia.minf.stbl.stsd.entries[0].esds.esd.descs[0].descs[0].tag == 0x05);

    return this.file.moov.traks[1].mdia.minf.stbl.stsd.entries[0].esds.esd.descs[0].descs[0].data;
  }

 //source.start
 //    this.source.start(this._onSamples.bind(this));
 //表示可以开始样本处理（分段或提取）。 已经收到的样本数据将被处理，新的缓冲区追加操作也将触发样本处理。
  start(onSamples) {
    console.log("mp4file started")
    // debugger;
    //_onSamples ： this._onSamples
    this._onSamples = onSamples;
    // this.file.setExtractionOptions(track.id);
    this.file.start();
  }

  stop() {
    this.file.stop();
  }

  //onsamples重写了，之前在这里构建encodedVideoChunk，这里调用_onSamples
  onSamples(track_id, ref, samples) {
    // debugger;
    // for (const sample of samples) {
    //   const type = sample.is_sync ? "key" : "delta";

    //   const chunk = new EncodedVideoChunk({
    //     type: type,
    //     timestamp: sample.cts,
    //     duration: sample.duration,
    //     data: sample.data
    //   });

    //   this._onChunk(chunk);
    // }
    this._onSamples(samples)
  }
}

function debugLog(msg) {
  if (!ENABLE_DEBUG_LOGGING) {
    return;
  }
  console.debug(msg);
}

class Writer {
  constructor(size) {
    this.data = new Uint8Array(size);
    this.idx = 0;
    this.size = size;
  }

  getData() {
    if(this.idx != this.size)
      throw "Mismatch between size reserved and sized used"

    return this.data.slice(0, this.idx);
  }

  writeUint8(value) {
    this.data.set([value], this.idx);
    this.idx++;
  }

  writeUint16(value) {
    // TODO: find a more elegant solution to endianess.
    var arr = new Uint16Array(1);
    arr[0] = value;
    var buffer = new Uint8Array(arr.buffer);
    this.data.set([buffer[1], buffer[0]], this.idx);
    this.idx +=2;
  }

  writeUint32(value) {
    var arr = new Uint32Array(1);
    arr[0] = value;
    var buffer = new Uint8Array(arr.buffer);
    this.data.set([buffer[3], buffer[2], buffer[1], buffer[0]], this.idx);
    this.idx +=4;
  }

  writeUint8Array(value) {
    this.data.set(value, this.idx);
    this.idx += value.length;
  }
}

// class MP4Demuxer {
//   constructor(uri) {
//     this.source = new MP4Source(uri);
//   }

//   getExtradata(hvccBox) {
//     var i, j;
//     var size = 23;
//     for (i = 0; i < hvccBox.nalu_arrays.length; i++) {
//       // nalu length is encoded as a uint16.
//       size += 3;
//       for (j = 0; j < hvccBox.nalu_arrays[i].length; j++){
//         // console.log(hvccBox.nalu_arrays[i]["0"].data.length)
//         size += (2+hvccBox.nalu_arrays[i][j].data.length)
//       }
//     }
//     console.log(size)

//     var writer = new Writer(size);

//     writer.writeUint8(hvccBox.configurationVersion);
//     console.log(((hvccBox.general_profile_space)<<6)+((hvccBox.general_tier_flag)<<5)+(hvccBox.general_profile_idc))
//     writer.writeUint8(((hvccBox.general_profile_space)<<6)+((hvccBox.general_tier_flag)<<5)+(hvccBox.general_profile_idc));
    
//     writer.writeUint32(hvccBox.general_profile_compatibility);
//     writer.writeUint8Array(hvccBox.general_constraint_indicator);
//     writer.writeUint8(hvccBox.general_level_idc);
    
//     //?别人写的是24
//     writer.writeUint16((15<<12)+(hvccBox.min_spatial_segmentation_idc)); //???
//     console.log((63<<2)+(hvccBox.parallelismType))
//     writer.writeUint8((63<<2)+(hvccBox.parallelismType));
//     writer.writeUint8((63<<2)+(hvccBox.chroma_format_idc));
//     writer.writeUint8((31<<3)+(hvccBox.bit_depth_luma_minus8));
//     writer.writeUint8((31<<3)+(hvccBox.bit_depth_chroma_minus8));
//     writer.writeUint16(hvccBox.avgFrameRate);
//     writer.writeUint8(((hvccBox.constantFrameRate)<<6)+(((hvccBox.numTemporalLayers))<<3)+((hvccBox.temporalIdNested)<<2)+(hvccBox.lengthSizeMinusOne))
//     writer.writeUint8(hvccBox.nalu_arrays.length)
//     for(i = 0; i < hvccBox.nalu_arrays.length; i++){
//       let current = hvccBox.nalu_arrays[i]
//       console.log(((current.completeness)<<7)+(current.nalu_type))
//       writer.writeUint8(((current.completeness)<<7)+(current.nalu_type))

//       writer.writeUint16(current.length)
//       for(j = 0; j < current.length; j++){
//         console.log(111111)
//         console.log((current[j].data.length))
//         writer.writeUint16(current[j].data.length)
//         writer.writeUint8Array(current[j].data)
//         console.log(22222)
//       }
//     }
//     return writer.getData();
//   }

//   async getConfig() {
//     let info = await this.source.getInfo();
//     this.track = info.videoTracks[0];

//     var extradata = this.getExtradata(this.source.getHvccBox());

//     let config = {
//       codec: this.track.codec,
//       codedHeight: this.track.video.height,
//       codedWidth: this.track.video.width,
//       description: extradata,
//     }
//     console.log(config)

//     return Promise.resolve(config);
//   }

//   //这一步调用了start方法
//   start(onChunk) {
//     this.source.start(this.track, onChunk);
//   }
// }
