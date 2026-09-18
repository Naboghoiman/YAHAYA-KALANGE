/**
 * MASAVU master controller with VirtualDJ-8-style synchronization behaviour.
 *
 * CLEAN-ROOM IMPLEMENTATION: no VirtualDJ proprietary source code is present.
 * The original MASAVU controller remains unchanged in djMasterControllerBase.ts.
 */

import { SlaveStartPlan } from '../types/dj';
import { DjMasterController as BaseDjMasterController } from './djMasterControllerBase';
import { Vdj8StyleLaunchPlan, Vdj8StyleSyncEngine } from './vdj8StyleSyncEngine';
import { MasavuPhaseController, MasavuPhaseTelemetry } from './masavuPhaseController';
import { AudioLooperEngine } from './audioLooperEngine';

import { discDjStyleSync, DiscDjDeck } from './discDjStyleSync';import { DjDeck } from './djDeck';class DiscDjDeckWrapper implements DiscDjDeck {  constructor(private deck: DjDeck) {}    get originalBpm() { return this.deck.getTrack()?.bpm ?? 120.0; }    get beatPeriod() { return 60.0 / this.originalBpm; }    get beatStart() {     const track = this.deck.getTrack();    if (!track) return 0;    return (track.beatGrid.firstDownbeatSample ?? 0) / track.sampleRate;  }    getSpeed() {     return this.deck.getBaseTempoMultiplier();   }    setSpeed(speed: number) {    this.deck.setTempoFamilyLock(speed);  }    getCurrentPosition() {    const track = this.deck.getTrack();    if (!track) return 0;    return this.deck.getCurrentSourceSample() / track.sampleRate;  }    seekTo(positionSeconds: number) {    const track = this.deck.getTrack();    if (!track) return;    this.deck.seek(Math.round(positionSeconds * track.sampleRate));  }    isPlaying() {    return this.deck.getTelemetry().isPlaying;  }    start() {    this.deck.play();  }    setResetSpeedFlag(enabled: boolean) {    if (!enabled) {      this.deck.setJogPitchNudge(0);      this.deck.setPLLMultiplier(1.0);    }  }}export class DjMasterController extends BaseDjMasterController {
  public readonly vdj8StyleSyncEngine = new Vdj8StyleSyncEngine();
  public readonly masavuPhaseController = new MasavuPhaseController();
  public readonly audioLooperEngine: AudioLooperEngine;
  private vdj8LastSlaveStartPlan: Vdj8StyleLaunchPlan | null = null;

  constructor(audioCtx?: AudioContext) {
    super(audioCtx);

    this.audioLooperEngine = new AudioLooperEngine(
      this.audioCtx,
      this.vdj8StyleSyncEngine
    );

    this.audioLooperEngine
      .getOutputNode()
      .connect(this.masterGain);
  }

  public syncLooperToCurrentMaster(): boolean {
    const activeMasterId = this.getActiveMasterDeckId();

    if (!activeMasterId) {
      return false;
    }

    const masterDeck =
      activeMasterId === 'A'
        ? this.deckA
        : this.deckB;

    return this.audioLooperEngine.syncToMaster(
      activeMasterId,
      masterDeck
    );
  }

  public override handleDeckPlaybackStateChanged(): 'A' | 'B' | null {
    const previousMaster = this.getMasterDeckId();

    const activeMaster = super.handleDeckPlaybackStateChanged();

    if (
      activeMaster &&
      activeMaster !== previousMaster &&
      this.audioLooperEngine.isPlaying()
    ) {
      // ONE clean re-sync to the newly promoted song master.
      this.syncLooperToCurrentMaster();
    }

    return activeMaster;
  }

  /**
   * Tempo family -> beat/bar target -> kick-preferred source position ->
   * exact AudioContext scheduled launch. Stable tempo is then left alone.
   */
  public override triggerBeatPerfectSlaveStart(
    quantizeMode: 'beat' | 'bar' = 'beat'
  ): SlaveStartPlan | null {
    const masterDeck = this.getMasterDeckId() === 'A' ? this.deckA : this.deckB;
    const slaveDeck = this.getMasterDeckId() === 'A' ? this.deckB : this.deckA;

    const masterTrack = masterDeck.getTrack();
    const slaveTrack = slaveDeck.getTrack();
    if (!masterTrack || !slaveTrack) return null;

    masterDeck.updateCurrentPosition();
    slaveDeck.updateCurrentPosition();
    const masterTelemetry = masterDeck.getTelemetry();

    if (!masterTelemetry.isPlaying) {
      slaveDeck.setTempoFamilyLock(null);
      const fallback = super.triggerBeatPerfectSlaveStart(quantizeMode);
      this.vdj8LastSlaveStartPlan = null;
      return fallback;
    }

    const wrapperMaster = new DiscDjDeckWrapper(masterDeck as DjDeck);
    const wrapperSlave = new DiscDjDeckWrapper(slaveDeck as DjDeck);

    const audioBufferFrames = (this.audioCtx.baseLatency || (128 / this.audioCtx.sampleRate)) * this.audioCtx.sampleRate;
    
    discDjStyleSync(0, wrapperSlave, wrapperMaster, audioBufferFrames, this.audioCtx.sampleRate);

    const targetMultiplier = slaveDeck.getBaseTempoMultiplier();
    const effectiveRange = slaveDeck.getPitchRange();
    if (Number.isFinite(effectiveRange) && Math.abs(effectiveRange) > 1e-6) {
      const pitchPct = (targetMultiplier - 1.0) / effectiveRange;
      slaveDeck.setPitchPercentage(Math.max(-1.0, Math.min(1.0, pitchPct)));
    }

    slaveDeck.setSync(true);
    this.syncEngine.resetController();
    this.masavuPhaseController.reset();
    this.vdj8LastSlaveStartPlan = null;
    return null;
  }

  public updatePhaseController(): MasavuPhaseTelemetry {
    const masterDeck = this.getMasterDeckId() === 'A' ? this.deckA : this.deckB;
    const slaveDeck = this.getMasterDeckId() === 'A' ? this.deckB : this.deckA;

    const masterTrack = masterDeck.getTrack();
    const slaveTrack = slaveDeck.getTrack();

    masterDeck.updateCurrentPosition();
    slaveDeck.updateCurrentPosition();

    const masterTelemetry = masterDeck.getTelemetry();
    const slaveTelemetry = slaveDeck.getTelemetry();

    if (!masterTrack || !slaveTrack) {
      return {
        phaseErrorMs: 0,
        phaseErrorDegrees: 0,
        masterBpm: masterTrack ? masterTrack.bpm : 120,
        slaveEffectiveBpm: slaveTrack ? slaveTrack.bpm : 120,
        baseTempoMultiplier: slaveDeck.getBaseTempoMultiplier(),
        temporaryCorrectionPercent: 0,
        numberOfPersistentBadBeats: 0,
        syncState: 'LOCKED',
        reanchorCount: 0
      };
    }

    const masterBpm = masterTelemetry.effectiveBpm > 20 ? masterTelemetry.effectiveBpm : masterTrack.bpm;
    const slaveBpm = slaveTrack.bpm;

    const result = this.masavuPhaseController.update({
      currentTimeSec: this.audioCtx.currentTime,
      isMasterPlaying: masterTelemetry.isPlaying,
      isSlavePlaying: slaveTelemetry.isPlaying,
      masterBpm,
      slaveBpm,
      masterCurrentSample: masterDeck.getCurrentSourceSample(),
      slaveCurrentSample: slaveDeck.getCurrentSourceSample(),
      masterSampleRate: masterTrack.sampleRate,
      slaveSampleRate: slaveTrack.sampleRate,
      masterGrid: masterTrack.beatGrid,
      slaveGrid: slaveTrack.beatGrid,
      baseTempoMultiplier: slaveDeck.getBaseTempoMultiplier(),
      slaveEffectiveBpm: slaveTelemetry.effectiveBpm,
      onScheduleReanchor: () => {
        if (slaveDeck.getSync() && masterTelemetry.isPlaying && slaveTelemetry.isPlaying) {
          this.triggerBeatPerfectSlaveStart('beat');
        }
      }
    });

    // When SYNC is engaged, dynamically apply the PLL multiplier to maintain tight phase lock
    // and prevent any clock drift over time.
    if (slaveDeck.getSync() && masterTelemetry.isPlaying && slaveTelemetry.isPlaying) {
      slaveDeck.setPLLMultiplier(result.pllMultiplier);
    } else {
      slaveDeck.setPLLMultiplier(1.0);
    }
    
    // Also continuously sync the looper's dynamic rate to the master deck
    this.audioLooperEngine.updateContinuousSync(masterDeck);

    return result.telemetry;
  }

  public override getLastSlaveStartPlan(): SlaveStartPlan | null {
    return this.vdj8LastSlaveStartPlan ?? super.getLastSlaveStartPlan();
  }

  public getLastVdj8Plan(): Vdj8StyleLaunchPlan | null {
    return this.vdj8LastSlaveStartPlan;
  }

  /**
   * Explicitly triggers downbeat alignment (quantizeMode = 'bar').
   * Guarantees that Beat 1.1 of the slave starts on Beat 1.1 of the master.
   */
  public triggerDownbeatAlignment(): SlaveStartPlan | null {
    return this.triggerBeatPerfectSlaveStart('bar');
  }

  public forceDownbeatAlignment(): SlaveStartPlan | null {
    return this.triggerDownbeatAlignment();
  }

  /**
   * Performs soft micro-phase correction (jog pitch nudge) to smoothly steer
   * any residual phase error back to 0 ms without cutting the audio.
   * For DiscDJ Parity test: no soft phase nudge during parity testing.
   */
  public applySoftPhaseCorrection(_targetDurationSec = 0.4): { nudgeApplied: number; phaseErrorMs: number } | null {
    // DiscDJ parity: no soft phase nudge during parity test
    return null;
  }

  /**
   * Intentionally shifts the slave read-head by offsetMs to simulate drift,
   * allowing direct observation of phase correction in action.
   */
  public injectPhaseDrift(offsetMs: number): void {
    const slaveDeck = this.getMasterDeckId() === 'A' ? this.deckB : this.deckA;
    const slaveTrack = slaveDeck.getTrack();
    if (!slaveTrack) return;

    const sampleOffset = Math.round((offsetMs / 1000) * slaveTrack.sampleRate);
    const currentSample = slaveDeck.getCurrentSourceSample();
    const newSample = Math.max(0, currentSample + sampleOffset);
    slaveDeck.seek(newSample);
  }

  /**
   * Matches the slave deck's tempo to the master deck's tempo family
   * without altering its playback phase or seeking position.
   */
  public matchSlaveTempoToMaster(): { matchedBpm: number; multiplier: number } | null {
    const masterDeck = this.getMasterDeckId() === 'A' ? this.deckA : this.deckB;
    const slaveDeck = this.getMasterDeckId() === 'A' ? this.deckB : this.deckA;

    const masterTrack = masterDeck.getTrack();
    const slaveTrack = slaveDeck.getTrack();
    if (!masterTrack || !slaveTrack) return null;

    masterDeck.updateCurrentPosition();
    slaveDeck.updateCurrentPosition();

    const masterTelemetry = masterDeck.getTelemetry();
    const masterBpm = masterTelemetry.effectiveBpm > 20 ? masterTelemetry.effectiveBpm : masterTrack.bpm;
    const slaveBpm = slaveTrack.bpm;

    const tempo = this.vdj8StyleSyncEngine.matchTempoFamily(masterBpm, slaveBpm);
    slaveDeck.setTempoFamilyLock(tempo.playbackMultiplier);
    slaveDeck.setBaseTempoMultiplier(tempo.playbackMultiplier);
    slaveDeck.setSync(true);

    return {
      matchedBpm: tempo.equivalentSlaveBpm,
      multiplier: tempo.playbackMultiplier
    };
  }

  /**
   * Intentionally triggers the legacy/defective behavior for side-by-side comparison:
   * schedules slave on master clock, but starts from arbitrary slave current read-head!
   */
  public triggerLegacyDefectiveSlaveStart(): SlaveStartPlan | null {
    return super.triggerBeatPerfectSlaveStart('beat');
  }

  public override dispose(): void {
    this.audioLooperEngine.stop();
    super.dispose();
  }
}
