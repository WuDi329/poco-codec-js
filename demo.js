const VIDEO_STREAM_TYPE = 1;
const AUDIO_STREAM_TYPE = 0;

import {max_video_config} from './resolution.js'
export class WebmMuxer{
    constructor(){

    }

    encoder_constraints = {
        // codec: 'av01.0.08M.08',
        codec: 'vp09.00.10.08.01',
        width: 640,
        height: 360,
        bitrate: 356000,
        framerate: 30,
        latencyMode: 'realtime'
    }
    async initialize(demuxer) {
        if(demuxer.streamType === AUDIO_STREAM_TYPE) {

        } else {
            // this.codec = 'av01.0.00M.08',//这里先写死
            this.codec = 'vp09.00.10.08.01'
            // this.displayWidth = demuxer.getDecoderConfig().displayWidth;
            // this.displayHeight = demuxer.getDecoderConfig().displayHeight;
            this.width= 640,
            this.height= 360,
            this.bitrate = 2500 * 100;
            this.framerate = 30;
            this.latencyMode = 'realtime';
        }
        
    
        //不管是videotrack还是audiotrack都ready了
        await this._tracksReady();
    
        if (this.streamType == AUDIO_STREAM_TYPE) {
          this._selectTrack(this.audioTrack);
        } else {
          this._selectTrack(this.videoTrack);
        }
        console.log('muxer initialize finished')
      }

    async getEncoderConfig() {
        //判断当前流类型
        //确实应该判断，但是这里先注释了
        // if (this.streamType == AUDIO_STREAM_TYPE) {
        //   return {
        //     codec: this.audioTrack.codec,
        //     sampleRate: this.audioTrack.audio.sample_rate,
        //     numberOfChannels: this.audioTrack.audio.channel_count,
        //     description: this.source.getAudioSpecificConfig()
        //   };
        // } else {
        //     return await max_video_config({
        //         ...encoder_constraints,
        //         ratio: 1920 / 1080
        //     }) || await max_video_config(encoder_constraints);
        // }

          console.log('in getencoder config');
          console.log(this.encoder_constraints)
            return await max_video_config({
                ...this.encoder_constraints,
                ratio: 640 / 360
            }) || await max_video_config(this.encoder_constraints);
      }
}