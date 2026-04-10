"use client";

import Image from "next/image";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

type SignalMessage = {
  type: string;
  roomId?: string;
  key?: string;
  name?: string;
  to?: string;
  from?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  selfId?: string;
  peers?: string[];
  peerId?: string;
  message?: string;
  text?: string;
  author?: string;
  messageId?: string;
  sentAt?: number;
  raised?: boolean;
};

type RemoteStream = {
  peerId: string;
  stream: MediaStream;
};

type SavedRoomProfile = {
  displayName: string;
  accessKey: string;
  updatedAt: number;
};

type ChatMessage = {
  id: string;
  senderId: string;
  author: string;
  text: string;
  time: string;
  isSelf: boolean;
};

const ROOM_PROFILE_COOKIE = "conferly-room-profiles";
const USER_PHOTO_STORAGE_KEY = "conferly-user-photo";

const rtcConfig: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export default function Home() {
  const [displayName, setDisplayName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [joined, setJoined] = useState(false);
  const [selfId, setSelfId] = useState("");
  const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([]);

  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(true);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const [permissionState, setPermissionState] = useState<
    "idle" | "requesting" | "granted" | "denied"
  >("idle");
  const [permissionError, setPermissionError] = useState("");
  const [showPermissionPrompt, setShowPermissionPrompt] = useState(true);

  const [viewMode, setViewMode] = useState<"gallery" | "speaker">("speaker");
  const [zoomScale, setZoomScale] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  const [activeSpeakerId, setActiveSpeakerId] = useState("");
  const [pinnedId, setPinnedId] = useState("");
  const [sidebarTab, setSidebarTab] = useState<"participants" | "chat" | null>(null);

  const [userPhoto, setUserPhoto] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [raisedHand, setRaisedHand] = useState(false);
  const [peerRaisedHands, setPeerRaisedHands] = useState<Record<string, boolean>>({});
  const [sharedScreenOwnerId, setSharedScreenOwnerId] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const permissionStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const conferenceStageRef = useRef<HTMLElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const controlsHideTimeoutRef = useRef<number | null>(null);
  const sidebarTabRef = useRef<"participants" | "chat" | null>(null);

  const [localMediaStream, setLocalMediaStream] = useState<MediaStream | null>(null);
  const [meetingStartedAt, setMeetingStartedAt] = useState<number | null>(null);

  const inviteText = useMemo(() => {
    if (!roomId || !accessKey) {
      return "";
    }

    return `Room: ${roomId}\nKey: ${accessKey}`;
  }, [roomId, accessKey]);

  const orderedRemoteStreams = useMemo(() => {
    const score = (peerId: string) => {
      if (pinnedId && peerId === pinnedId) return 0;
      if (!pinnedId && activeSpeakerId && peerId === activeSpeakerId) return 1;
      return 2;
    };

    return [...remoteStreams].sort((a, b) => score(a.peerId) - score(b.peerId));
  }, [remoteStreams, pinnedId, activeSpeakerId]);

  const spotlightId =
    pinnedId || sharedScreenOwnerId || activeSpeakerId || (orderedRemoteStreams[0]?.peerId ?? "local");

  useEffect(() => {
    loadSavedUserPhoto();
    const savedProfiles = readSavedProfiles();
    if (savedProfiles) {
      const currentRoom = roomId.trim();
      if (currentRoom && savedProfiles[currentRoom]) {
        const profile = savedProfiles[currentRoom];
        setDisplayName((current) => current || profile.displayName);
        setAccessKey((current) => current || profile.accessKey);
      }
    }

    void initializeMicrophonePermission();

    return () => {
      cleanupConference();
      stopPermissionPreview();
      clearControlsTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === conferenceStageRef.current);
    };

    document.addEventListener("fullscreenchange", syncFullscreenState);
    syncFullscreenState();

    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
    };
  }, []);

  useEffect(() => {
    sidebarTabRef.current = sidebarTab;
  }, [sidebarTab]);

  useEffect(() => {
    if (!isFullscreen) {
      clearControlsTimer();
      setControlsVisible(true);
      return;
    }

    setControlsVisible(true);
    scheduleControlsHide();

    return () => clearControlsTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen]);

  useEffect(() => {
    if (!joined) {
      return;
    }

    setMeetingStartedAt(Date.now());
  }, [joined]);

  async function initializeMicrophonePermission() {
    try {
      if (navigator.permissions?.query) {
        const status = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });

        if (status.state === "denied") {
          setPermissionState("denied");
          setPermissionError(
            "Microphone access is blocked. Open browser site permissions and allow Microphone."
          );
          setShowPermissionPrompt(true);
          return;
        }
      }

      await requestPermissionPreview();
    } catch {
      setShowPermissionPrompt(true);
    }
  }

  async function requestPermissionPreview() {
    if (permissionState === "requesting" || permissionState === "granted") {
      return;
    }

    setPermissionState("requesting");
    setPermissionError("");

    try {
      const stream = await acquireMicrophoneStream();
      permissionStreamRef.current = stream;
      setLocalMediaStream(stream);
      setPermissionState("granted");
      setShowPermissionPrompt(false);
    } catch (permissionErr) {
      setPermissionState("denied");
      setPermissionError(getPermissionHelpMessage(permissionErr));
      setShowPermissionPrompt(true);
    }
  }

  async function acquireMicrophoneStream() {
    return navigator.mediaDevices.getUserMedia({
      video: false,
      audio: true,
    });
  }

  function getPermissionHelpMessage(permissionErr: unknown) {
    if (permissionErr instanceof DOMException) {
      if (permissionErr.name === "NotAllowedError" || permissionErr.name === "PermissionDeniedError") {
        return "Microphone permission is blocked. Click the lock icon in the address bar and allow Microphone, then retry.";
      }

      if (permissionErr.name === "NotFoundError") {
        return "No microphone device was found. Connect a microphone and retry.";
      }

      if (permissionErr.name === "NotReadableError") {
        return "Microphone is busy in another app. Close that app and retry.";
      }
    }

    return "Unable to start microphone access. Retry and allow Microphone in the browser prompt.";
  }

  function stopPermissionPreview() {
    if (permissionStreamRef.current) {
      for (const track of permissionStreamRef.current.getTracks()) {
        track.stop();
      }
      permissionStreamRef.current = null;
    }
  }

  function loadSavedUserPhoto() {
    if (typeof window === "undefined") {
      return;
    }

    const savedPhoto = window.localStorage.getItem(USER_PHOTO_STORAGE_KEY);
    if (savedPhoto) {
      setUserPhoto(savedPhoto);
    }
  }

  function saveUserPhoto(dataUrl: string) {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(USER_PHOTO_STORAGE_KEY, dataUrl);
    setUserPhoto(dataUrl);
  }

  function removeUserPhoto() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(USER_PHOTO_STORAGE_KEY);
    }

    setUserPhoto("");
  }

  function handlePhotoSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        saveUserPhoto(reader.result);
      }
    };
    reader.readAsDataURL(file);
  }

  function readSavedProfiles(): Record<string, SavedRoomProfile> | null {
    if (typeof document === "undefined") {
      return null;
    }

    const match = document.cookie.match(
      new RegExp(`(?:^|; )${ROOM_PROFILE_COOKIE}=([^;]*)`)
    );

    if (!match) {
      return null;
    }

    try {
      return JSON.parse(decodeURIComponent(match[1])) as Record<string, SavedRoomProfile>;
    } catch {
      return null;
    }
  }

  function writeSavedProfile(room: string, profile: SavedRoomProfile) {
    if (typeof document === "undefined") {
      return;
    }

    const currentProfiles = readSavedProfiles() ?? {};
    currentProfiles[room] = profile;

    document.cookie = `${ROOM_PROFILE_COOKIE}=${encodeURIComponent(
      JSON.stringify(currentProfiles)
    )}; path=/; max-age=31536000; samesite=lax`;
  }

  async function joinConference() {
    setError("");

    if (!displayName.trim() || !roomId.trim() || !accessKey.trim()) {
      setError("Name, room, and security key are required.");
      return;
    }

    const room = roomId.trim();
    const name = displayName.trim();
    const key = accessKey.trim();

    const savedProfiles = readSavedProfiles();
    const savedProfile = savedProfiles?.[room];
    if (savedProfile) {
      if (savedProfile.displayName !== name) {
        setError("The display name does not match the saved profile for this room.");
        return;
      }

      if (savedProfile.accessKey !== key) {
        setError("The security key does not match the saved profile for this room.");
        return;
      }
    }

    try {
      if (!permissionStreamRef.current) {
        permissionStreamRef.current = await acquireMicrophoneStream();
      }

      const stream = permissionStreamRef.current;
      if (!stream) {
        setError("Microphone access is required to join.");
        return;
      }

      permissionStreamRef.current = null;
      localStreamRef.current = stream;
      setLocalMediaStream(stream);
      setIsCameraOff(true);

      const configuredSignalingUrl = process.env.NEXT_PUBLIC_SIGNALING_URL?.trim();
      const defaultSignalingUrl = `${
        window.location.protocol === "https:" ? "wss" : "ws"
      }://${window.location.host}/ws`;
      const signalingUrl = configuredSignalingUrl || defaultSignalingUrl;
      const ws = new WebSocket(signalingUrl);

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "join",
            roomId: room,
            key,
            name,
          })
        );
      };

      ws.onmessage = async (event) => {
        const payload = JSON.parse(event.data) as SignalMessage;
        await handleSignal(payload);
      };

      ws.onerror = () => {
        setError("Signaling connection failed.");
      };

      ws.onclose = () => {
        if (joined) {
          leaveConference();
        }
      };

      wsRef.current = ws;

      writeSavedProfile(room, {
        displayName: name,
        accessKey: key,
        updatedAt: Date.now(),
      });

      setShowPermissionPrompt(false);
    } catch {
      setError("Microphone permission is required.");
    }
  }

  async function handleSignal(message: SignalMessage) {
    if (message.type === "error") {
      setError(message.message || "Conference error.");
      leaveConference();
      return;
    }

    if (message.type === "joined") {
      setSelfId(message.selfId || "");
      setJoined(true);

      for (const peerId of message.peers || []) {
        createPeerConnection(peerId, false);
      }
      return;
    }

    if (message.type === "peer-joined" && message.peerId) {
      await createPeerConnection(message.peerId, true);
      return;
    }

    if (message.type === "offer" && message.from && message.sdp) {
      const pc = await createPeerConnection(message.from, false);
      await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: "answer", to: message.from, sdp: answer });
      return;
    }

    if (message.type === "answer" && message.from && message.sdp) {
      const pc = peerConnectionsRef.current.get(message.from);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
      }
      return;
    }

    if (message.type === "ice-candidate" && message.from && message.candidate) {
      const pc = peerConnectionsRef.current.get(message.from);
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
      }
      return;
    }

    if (message.type === "peer-left" && message.peerId) {
      removePeer(message.peerId);
      return;
    }

    if (message.type === "chat" && message.text) {
      const senderId = message.from || "";
      const isSelf = Boolean(selfId && senderId === selfId);

      const chat: ChatMessage = {
        id: message.messageId || `${Date.now()}-${Math.random()}`,
        senderId,
        author: message.author || "Participant",
        text: message.text,
        isSelf,
        time: message.sentAt
          ? new Date(message.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      setChatMessages((current) => [...current, chat]);

      if (sidebarTabRef.current !== "chat" && !isSelf) {
        setUnreadChatCount((current) => current + 1);
      }

      return;
    }

    if (message.type === "raise-hand" && message.from) {
      setPeerRaisedHands((current) => ({
        ...current,
        [message.from as string]: Boolean(message.raised),
      }));
    }
  }

  function sendSignal(payload: SignalMessage) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }

  async function createPeerConnection(peerId: string, initiator: boolean) {
    const existing = peerConnectionsRef.current.get(peerId);
    if (existing) {
      return existing;
    }

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnectionsRef.current.set(peerId, pc);

    const localStream = localStreamRef.current;
    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: "ice-candidate",
          to: peerId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) {
        return;
      }

      const isSharedScreen = hasDisplayTrack(stream.getVideoTracks()[0]);

      setRemoteStreams((current) => {
        const remaining = current.filter((entry) => entry.peerId !== peerId);
        return [...remaining, { peerId, stream }];
      });

      setSharedScreenOwnerId((current) => {
        if (isSharedScreen) {
          return peerId;
        }

        return current === peerId ? "" : current;
      });
    };

    pc.onconnectionstatechange = () => {
      if (["closed", "failed", "disconnected"].includes(pc.connectionState)) {
        removePeer(peerId);
      }
    };

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ type: "offer", to: peerId, sdp: offer });
    }

    return pc;
  }

  function removePeer(peerId: string) {
    const peer = peerConnectionsRef.current.get(peerId);
    if (peer) {
      peer.close();
      peerConnectionsRef.current.delete(peerId);
    }

    setRemoteStreams((current) => current.filter((entry) => entry.peerId !== peerId));
    setActiveSpeakerId((current) => (current === peerId ? "" : current));
    setPinnedId((current) => (current === peerId ? "" : current));
    setSharedScreenOwnerId((current) => (current === peerId ? "" : current));
    setPeerRaisedHands((current) => {
      const next = { ...current };
      delete next[peerId];
      return next;
    });
  }

  function cleanupConference() {
    for (const peer of peerConnectionsRef.current.values()) {
      peer.close();
    }
    peerConnectionsRef.current.clear();

    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop();
      }
      localStreamRef.current = null;
    }

    if (permissionStreamRef.current) {
      for (const track of permissionStreamRef.current.getTracks()) {
        track.stop();
      }
      permissionStreamRef.current = null;
    }

    setLocalMediaStream(null);
    clearControlsTimer();

    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        sendSignal({ type: "leave" });
      }
      wsRef.current.close();
      wsRef.current = null;
    }
  }

  function leaveConference() {
    cleanupConference();
    setJoined(false);
    setSelfId("");
    setRemoteStreams([]);
    setIsMuted(false);
    setIsCameraOff(true);
    setIsSharingScreen(false);
    setActiveSpeakerId("");
    setPinnedId("");
    setRaisedHand(false);
    setPeerRaisedHands({});
    setSharedScreenOwnerId("");
    setSidebarTab(null);
    setMeetingStartedAt(null);
    setUnreadChatCount(0);
  }

  function toggleMute() {
    const localStream = localStreamRef.current;
    if (!localStream) {
      return;
    }

    const nextMuted = !isMuted;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
  }

  async function toggleCamera() {
    const localStream = localStreamRef.current;
    if (!localStream) {
      return;
    }

    const videoTracks = localStream.getVideoTracks();

    if (videoTracks.length === 0) {
      try {
        const camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        replaceOutgoingTracks(camera, { keepExistingAudio: true });
        setIsCameraOff(false);
      } catch {
        setError("Camera is unavailable on this device.");
      }
      return;
    }

    const nextCameraOff = !isCameraOff;
    videoTracks.forEach((track) => {
      track.enabled = !nextCameraOff;
    });
    setIsCameraOff(nextCameraOff);
  }

  async function toggleScreenShare() {
    const localStream = localStreamRef.current;
    if (!localStream) {
      return;
    }

    if (isSharingScreen) {
      await stopScreenShareAndRestoreVideo();
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      const [screenTrack] = screenStream.getVideoTracks();
      if (screenTrack) {
        screenTrack.onended = () => {
          void stopScreenShareAndRestoreVideo();
        };
      }

      replaceOutgoingTracks(screenStream, { keepExistingAudio: true });
      setIsSharingScreen(true);
      setSharedScreenOwnerId("local");
    } catch {
      setError("Screen sharing was canceled.");
    }
  }

  async function stopScreenShareAndRestoreVideo() {
    try {
      const camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      replaceOutgoingTracks(camera, { keepExistingAudio: true });
      setIsCameraOff(false);
    } catch {
      replaceOutgoingTracks(new MediaStream(), { keepExistingAudio: true });
      setIsCameraOff(true);
    }

    setIsSharingScreen(false);
    setSharedScreenOwnerId((current) => (current === "local" ? "" : current));
  }

  function replaceOutgoingTracks(
    newStream: MediaStream,
    options: { keepExistingAudio?: boolean } = {}
  ) {
    const currentStream = localStreamRef.current;
    if (!currentStream) {
      return;
    }

    const audioTracks = options.keepExistingAudio
      ? currentStream.getAudioTracks()
      : newStream.getAudioTracks();
    const videoTracks = newStream.getVideoTracks();

    const merged = new MediaStream([...audioTracks, ...videoTracks]);

    for (const pc of peerConnectionsRef.current.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === "audio") {
          sender.replaceTrack(audioTracks[0] || null);
        }
        if (sender.track?.kind === "video") {
          sender.replaceTrack(videoTracks[0] || null);
        }
      }
    }

    currentStream.getTracks().forEach((track) => {
      if (!audioTracks.includes(track) && !videoTracks.includes(track)) {
        track.stop();
      }
    });

    localStreamRef.current = merged;
    setLocalMediaStream(merged);
    setIsCameraOff(videoTracks.length === 0);
  }

  function toggleRaiseHand() {
    const nextRaised = !raisedHand;
    setRaisedHand(nextRaised);
    sendSignal({ type: "raise-hand", raised: nextRaised });
  }

  function hasDisplayTrack(track: MediaStreamTrack | undefined) {
    if (!track) {
      return false;
    }

    return /(screen|window|display|monitor|tab)/i.test(track.label);
  }

  async function copyInvite() {
    if (!inviteText) {
      return;
    }

    await navigator.clipboard.writeText(inviteText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  async function toggleFullscreenView() {
    const stage = conferenceStageRef.current;
    if (!stage) {
      return;
    }

    if (document.fullscreenElement === stage) {
      await document.exitFullscreen();
      return;
    }

    await stage.requestFullscreen();
  }

  function clearControlsTimer() {
    if (controlsHideTimeoutRef.current !== null) {
      window.clearTimeout(controlsHideTimeoutRef.current);
      controlsHideTimeoutRef.current = null;
    }
  }

  function scheduleControlsHide() {
    clearControlsTimer();
    controlsHideTimeoutRef.current = window.setTimeout(() => {
      setControlsVisible(false);
    }, 2200);
  }

  function handleStageActivity() {
    if (!isFullscreen) {
      return;
    }

    setControlsVisible(true);
    scheduleControlsHide();
  }

  function toggleSidebar(tab: "participants" | "chat") {
    setSidebarTab((current) => {
      const next = current === tab ? null : tab;
      if (next === "chat") {
        setUnreadChatCount(0);
      }
      return next;
    });
  }

  function sendChatMessage() {
    const text = chatDraft.trim();
    if (!text) {
      return;
    }

    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setError("Chat connection is not ready. Rejoin the meeting and try again.");
      return;
    }

    sendSignal({
      type: "chat",
      text,
      name: displayName.trim() || "You",
    });
    setChatDraft("");
  }

  const elapsedTime = useMeetingTimer(meetingStartedAt);

  return (
    <main className="min-h-screen bg-gradient-to-b from-[#111827] to-[#0b1220] text-slate-100">
      {showPermissionPrompt && !joined ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm">
          <section className="glass w-full max-w-2xl rounded-3xl p-6 shadow-2xl shadow-black/40 md:p-8">
            <BrandMark />
            <h2 className="mt-3 text-2xl font-bold text-slate-900 md:text-3xl">
              Enable Microphone Permission
            </h2>
            <p className="mt-3 text-sm text-slate-700 md:text-base">
              Conferly checks your microphone permission when the page loads. If access is already
              allowed, this popup closes automatically.
            </p>
            {permissionState === "denied" ? (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <p className="font-semibold">Permission action required</p>
                <p className="mt-1">{permissionError}</p>
              </div>
            ) : null}
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                onClick={() => void requestPermissionPreview()}
                className="rounded-xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[var(--accent-strong)]"
              >
                {permissionState === "requesting"
                  ? "Waiting for Browser Prompt..."
                  : permissionState === "denied"
                    ? "Retry Microphone Permission"
                    : "Enable Microphone"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <div className="mx-auto flex min-h-screen w-full max-w-[1400px] flex-col gap-5 p-4 md:p-6">
        {!joined ? (
          <section className="glass mx-auto w-full max-w-5xl rounded-3xl p-6 shadow-xl shadow-black/25 md:p-8">
            <header className="flex flex-wrap items-center justify-between gap-3">
              <BrandMark />
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-teal-500"
              >
                Set User Photo
              </button>
            </header>

            <div className="mt-6 grid items-start gap-6 md:grid-cols-[240px_1fr]">
              <div className="rounded-2xl border border-slate-300/70 bg-white/80 p-4">
                <p className="text-sm font-semibold text-slate-700">Your Profile</p>
                <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-950">
                  <UserPhotoPreview photoUrl={userPhoto} compact />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => photoInputRef.current?.click()}
                    className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--accent-strong)]"
                  >
                    Upload Photo
                  </button>
                  {userPhoto ? (
                    <button
                      type="button"
                      onClick={removeUserPhoto}
                      className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-teal-500"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handlePhotoSelection}
                />
              </div>



              <div className="rounded-2xl border border-slate-300/70 bg-white/80 p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-700">Join Meeting</p>
                <h1 className="mt-2 text-3xl font-bold text-slate-900">Conferly Room</h1>
                <p className="mt-2 text-sm text-slate-600">
                  Fast join with room key security, speaker view, gallery view, and meeting controls.
                </p>

                <div className="mt-6 grid gap-4 md:grid-cols-3">
                  <label className="text-sm font-semibold text-slate-700">
                    Display Name
                    <input
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="Your name"
                      className="mt-2 w-full rounded-xl border border-slate-300/70 bg-white px-3 py-2 text-sm outline-none ring-teal-600 transition focus:ring"
                    />
                  </label>
                  <label className="text-sm font-semibold text-slate-700">
                    Room ID
                    <input
                      value={roomId}
                      onChange={(event) => setRoomId(event.target.value)}
                      placeholder="team-sync"
                      className="mt-2 w-full rounded-xl border border-slate-300/70 bg-white px-3 py-2 text-sm outline-none ring-teal-600 transition focus:ring"
                    />
                  </label>
                  <label className="text-sm font-semibold text-slate-700">
                    Security Key
                    <input
                      value={accessKey}
                      onChange={(event) => setAccessKey(event.target.value)}
                      placeholder="secure-room-key"
                      type="password"
                      className="mt-2 w-full rounded-xl border border-slate-300/70 bg-white px-3 py-2 text-sm outline-none ring-teal-600 transition focus:ring"
                    />
                  </label>
                </div>

                <button
                  onClick={joinConference}
                  className="mt-6 rounded-xl bg-[var(--accent)] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[var(--accent-strong)]"
                >
                  Join Conference
                </button>

                {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
              </div>
            </div>
          </section>
        ) : (
          <section
            ref={conferenceStageRef}
            className="flex min-h-[82vh] flex-col gap-4"
            onMouseMove={handleStageActivity}
            onPointerDown={handleStageActivity}
            onKeyDown={handleStageActivity}
          >
            <header className="flex items-center justify-between rounded-2xl border border-slate-700/60 bg-slate-900/70 px-4 py-3 backdrop-blur">
              <div className="flex items-center gap-3">
                <Image src="/icon.png" alt="Conferly logo" width={28} height={28} priority />
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Meeting</p>
                  <p className="text-base font-semibold">{roomId}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 text-sm text-slate-300">
                <span className="rounded-full border border-slate-600 px-3 py-1">{elapsedTime}</span>
                <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-emerald-300">
                  Encrypted
                </span>
              </div>
            </header>

            <div className="flex min-h-0 flex-1 gap-4">
              <div className="relative flex min-h-0 flex-1 flex-col rounded-2xl border border-slate-700/60 bg-slate-900/70 p-3 backdrop-blur">
                {viewMode === "gallery" ? (
                  <GalleryGrid
                    localMediaStream={localMediaStream}
                    localLabel={`You ${selfId ? `(${selfId.slice(0, 8)})` : ""}`}
                    userPhoto={userPhoto}
                    remoteStreams={orderedRemoteStreams}
                    activeSpeakerId={activeSpeakerId}
                    onActiveSpeakerChange={setActiveSpeakerId}
                    pinnedId={pinnedId}
                    onPinChange={setPinnedId}
                    zoomScale={zoomScale}
                  />
                ) : (
                  <SpeakerView
                    localMediaStream={localMediaStream}
                    userPhoto={userPhoto}
                    localLabel={`You ${selfId ? `(${selfId.slice(0, 8)})` : ""}`}
                    spotlightId={spotlightId}
                    remoteStreams={orderedRemoteStreams}
                    activeSpeakerId={activeSpeakerId}
                    onActiveSpeakerChange={setActiveSpeakerId}
                    pinnedId={pinnedId}
                    onPinChange={setPinnedId}
                    zoomScale={zoomScale}
                  />
                )}

                <div
                  className={`pointer-events-none absolute bottom-4 left-1/2 z-20 w-[min(980px,92%)] -translate-x-1/2 transition-all duration-300 ${
                    isFullscreen && !controlsVisible ? "translate-y-28 opacity-0" : "translate-y-0 opacity-100"
                  }`}
                >
                  <div className="pointer-events-auto rounded-2xl border border-slate-700/80 bg-slate-950/90 px-4 py-3 shadow-2xl shadow-black/50 backdrop-blur">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <ControlButton
                          label={isMuted ? "Unmute" : "Mute"}
                          active={!isMuted}
                          onClick={toggleMute}
                        />
                        <ControlButton
                          label={isCameraOff ? "Start Cam" : "Stop Cam"}
                          active={!isCameraOff}
                          onClick={() => void toggleCamera()}
                        />
                        <ControlButton
                          label={isSharingScreen ? "Stop Share" : "Share"}
                          active={isSharingScreen}
                          onClick={() => void toggleScreenShare()}
                        />
                        <ControlButton
                          label={raisedHand ? "Lower Hand" : "Raise Hand"}
                          active={raisedHand}
                          onClick={toggleRaiseHand}
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <ControlButton
                          label={viewMode === "gallery" ? "Speaker View" : "Gallery View"}
                          active
                          onClick={() =>
                            setViewMode((current) =>
                              current === "gallery" ? "speaker" : "gallery"
                            )
                          }
                        />
                        <ControlButton
                          label={sidebarTab === "participants" ? "Hide People" : "Participants"}
                          active={sidebarTab === "participants"}
                          onClick={() => toggleSidebar("participants")}
                        />
                        <ControlButton
                          label={
                            sidebarTab === "chat"
                              ? "Hide Chat"
                              : unreadChatCount > 0
                                ? `Chat (${unreadChatCount})`
                                : "Chat"
                          }
                          active={sidebarTab === "chat"}
                          onClick={() => toggleSidebar("chat")}
                        />
                        <ControlButton
                          label={isFullscreen ? "Exit Full" : "Fullscreen"}
                          active
                          onClick={() => void toggleFullscreenView()}
                        />
                        <button
                          onClick={leaveConference}
                          className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700"
                        >
                          Leave
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center gap-3">
                      <span className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
                        Zoom
                      </span>
                      <input
                        type="range"
                        min={0.8}
                        max={1.4}
                        step={0.05}
                        value={zoomScale}
                        onChange={(event) => setZoomScale(Number(event.target.value))}
                        className="w-full accent-teal-500"
                      />
                      <span className="w-12 text-right text-xs font-semibold text-slate-300">
                        {Math.round(zoomScale * 100)}%
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {sidebarTab ? (
                <aside className="w-[320px] shrink-0 rounded-2xl border border-slate-700/60 bg-slate-900/75 p-4 backdrop-blur">
                  {sidebarTab === "participants" ? (
                    <ParticipantsPanel
                      selfLabel={displayName || "You"}
                      selfId={selfId}
                      remoteStreams={orderedRemoteStreams}
                      raisedHand={raisedHand}
                      peerRaisedHands={peerRaisedHands}
                    />
                  ) : (
                    <ChatPanel
                      messages={chatMessages}
                      draft={chatDraft}
                      onDraftChange={setChatDraft}
                      onSend={sendChatMessage}
                      selfId={selfId}
                    />
                  )}
                </aside>
              ) : null}
            </div>

            {error ? <p className="text-sm text-red-300">{error}</p> : null}

            <div className="flex items-center gap-3 text-sm text-slate-300">
              <button
                onClick={copyInvite}
                className="rounded-xl border border-slate-600 bg-slate-900/70 px-3 py-2 text-sm font-semibold transition hover:border-teal-500"
              >
                {copied ? "Invite Copied" : "Copy Invite"}
              </button>
              {pinnedId ? (
                <button
                  onClick={() => setPinnedId("")}
                  className="rounded-xl border border-slate-600 bg-slate-900/70 px-3 py-2 text-sm font-semibold transition hover:border-teal-500"
                >
                  Clear Pin
                </button>
              ) : null}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function GalleryGrid({
  localMediaStream,
  localLabel,
  userPhoto,
  remoteStreams,
  activeSpeakerId,
  onActiveSpeakerChange,
  pinnedId,
  onPinChange,
  zoomScale,
}: {
  localMediaStream: MediaStream | null;
  localLabel: string;
  userPhoto: string;
  remoteStreams: RemoteStream[];
  activeSpeakerId: string;
  onActiveSpeakerChange: (peerId: string) => void;
  pinnedId: string;
  onPinChange: (peerId: string) => void;
  zoomScale: number;
}) {
  return (
    <div
      className="grid h-full gap-4 sm:grid-cols-2 xl:grid-cols-3"
      style={{ transform: `scale(${zoomScale})`, transformOrigin: "center" }}
    >
      <ParticipantTile
        id="local"
        label={localLabel}
        stream={localMediaStream}
        photoUrl={userPhoto}
        isActiveSpeaker={activeSpeakerId === "local"}
        isPinned={pinnedId === "local"}
        onPin={() => onPinChange("local")}
        onSpeakingChange={(speaking) => {
          if (speaking) onActiveSpeakerChange("local");
        }}
      />

      {remoteStreams.map(({ peerId, stream }) => (
        <ParticipantTile
          key={peerId}
          id={peerId}
          label={`Participant ${peerId.slice(0, 8)}`}
          stream={stream}
          isActiveSpeaker={activeSpeakerId === peerId}
          isPinned={pinnedId === peerId}
          onPin={() => onPinChange(peerId)}
          onSpeakingChange={(speaking) => {
            if (speaking) onActiveSpeakerChange(peerId);
          }}
        />
      ))}
    </div>
  );
}

function SpeakerView({
  localMediaStream,
  userPhoto,
  localLabel,
  spotlightId,
  remoteStreams,
  activeSpeakerId,
  onActiveSpeakerChange,
  pinnedId,
  onPinChange,
  zoomScale,
}: {
  localMediaStream: MediaStream | null;
  userPhoto: string;
  localLabel: string;
  spotlightId: string;
  remoteStreams: RemoteStream[];
  activeSpeakerId: string;
  onActiveSpeakerChange: (peerId: string) => void;
  pinnedId: string;
  onPinChange: (peerId: string) => void;
  zoomScale: number;
}) {
  const spotlightRemote = remoteStreams.find((entry) => entry.peerId === spotlightId);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="min-h-0 flex-1" style={{ transform: `scale(${zoomScale})`, transformOrigin: "center" }}>
        {spotlightId === "local" || !spotlightRemote ? (
          <ParticipantTile
            id="local"
            label={`${localLabel} (Spotlight)`}
            stream={localMediaStream}
            photoUrl={userPhoto}
            isActiveSpeaker={activeSpeakerId === "local"}
            isPinned={pinnedId === "local"}
            onPin={() => onPinChange("local")}
            onSpeakingChange={(speaking) => {
              if (speaking) onActiveSpeakerChange("local");
            }}
            large
          />
        ) : (
          <ParticipantTile
            id={spotlightRemote.peerId}
            label={`Participant ${spotlightRemote.peerId.slice(0, 8)} (Spotlight)`}
            stream={spotlightRemote.stream}
            isActiveSpeaker={activeSpeakerId === spotlightRemote.peerId}
            isPinned={pinnedId === spotlightRemote.peerId}
            onPin={() => onPinChange(spotlightRemote.peerId)}
            onSpeakingChange={(speaking) => {
              if (speaking) onActiveSpeakerChange(spotlightRemote.peerId);
            }}
            large
          />
        )}
      </div>

      <div className="flex gap-3 overflow-x-auto pb-1">
        <div className="min-w-[220px]">
          <ParticipantTile
            id="local"
            label={localLabel}
            stream={localMediaStream}
            photoUrl={userPhoto}
            isActiveSpeaker={activeSpeakerId === "local"}
            isPinned={pinnedId === "local"}
            onPin={() => onPinChange("local")}
            onSpeakingChange={(speaking) => {
              if (speaking) onActiveSpeakerChange("local");
            }}
          />
        </div>

        {remoteStreams.map(({ peerId, stream }) => (
          <div key={peerId} className="min-w-[220px]">
            <ParticipantTile
              id={peerId}
              label={`Participant ${peerId.slice(0, 8)}`}
              stream={stream}
              isActiveSpeaker={activeSpeakerId === peerId}
              isPinned={pinnedId === peerId}
              onPin={() => onPinChange(peerId)}
              onSpeakingChange={(speaking) => {
                if (speaking) onActiveSpeakerChange(peerId);
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ParticipantTile({
  id,
  label,
  stream,
  photoUrl,
  isActiveSpeaker,
  isPinned,
  onPin,
  onSpeakingChange,
  large = false,
}: {
  id: string;
  label: string;
  stream: MediaStream | null;
  photoUrl?: string;
  isActiveSpeaker: boolean;
  isPinned: boolean;
  onPin: () => void;
  onSpeakingChange: (speaking: boolean) => void;
  large?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const speaking = useSpeaking(stream, onSpeakingChange);
  const hasVideo = Boolean(stream?.getVideoTracks().length);

  useEffect(() => {
    if (videoRef.current && stream && hasVideo) {
      videoRef.current.srcObject = stream;
    }
  }, [stream, hasVideo]);

  return (
    <article
      className={`tile-in glass relative overflow-hidden rounded-2xl border p-3 ${
        isActiveSpeaker ? "border-emerald-400 ring-2 ring-emerald-500/60" : "border-slate-600/60"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="truncate text-xs font-semibold uppercase tracking-[0.12em] text-slate-200">
          {label}
        </p>
        <div className="flex items-center gap-2">
          {speaking ? <SpeakingBadge /> : null}
          <button
            onClick={onPin}
            className={`rounded-lg px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] transition ${
              isPinned
                ? "bg-teal-600 text-white"
                : "border border-slate-500 bg-slate-800/80 text-slate-200 hover:border-teal-400"
            }`}
          >
            {isPinned ? "Pinned" : "Pin"}
          </button>
        </div>
      </div>

      <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-950">
        {hasVideo ? (
          <video
            ref={videoRef}
            autoPlay
            muted={id === "local"}
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <UserPhotoPreview photoUrl={photoUrl || ""} compact={!large} fillContainer />
        )}
      </div>
    </article>
  );
}

function ControlButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
        active
          ? "border border-teal-500/60 bg-teal-500/10 text-teal-200"
          : "border border-slate-600 bg-slate-900/50 text-slate-200 hover:border-slate-400"
      }`}
    >
      {label}
    </button>
  );
}

function ParticipantsPanel({
  selfLabel,
  selfId,
  remoteStreams,
  raisedHand,
  peerRaisedHands,
}: {
  selfLabel: string;
  selfId: string;
  remoteStreams: RemoteStream[];
  raisedHand: boolean;
  peerRaisedHands: Record<string, boolean>;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">Participants</h3>
      <p className="mt-1 text-xs text-slate-400">{remoteStreams.length + 1} in meeting</p>

      <ul className="mt-4 space-y-2">
        <li className="rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm">
          <span className="font-semibold">{selfLabel || "You"}</span>
          {selfId ? <span className="ml-2 text-xs text-slate-400">({selfId.slice(0, 8)})</span> : null}
          {raisedHand ? <span className="ml-2 text-xs text-amber-300">Raised Hand</span> : null}
        </li>
        {remoteStreams.map(({ peerId }) => (
          <li
            key={peerId}
            className="rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm"
          >
            Participant {peerId.slice(0, 8)}
            {peerRaisedHands[peerId] ? (
              <span className="ml-2 text-xs text-amber-300">Raised Hand</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChatPanel({
  messages,
  draft,
  onDraftChange,
  onSend,
  selfId,
}: {
  messages: ChatMessage[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  selfId: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }

    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const groupedMessages = useMemo(() => {
    const groups: Array<{
      key: string;
      senderId: string;
      author: string;
      isSelf: boolean;
      time: string;
      lines: string[];
    }> = [];

    for (const message of messages) {
      const previous = groups[groups.length - 1];
      if (previous && previous.senderId === message.senderId) {
        previous.lines.push(message.text);
        previous.time = message.time;
      } else {
        groups.push({
          key: message.id,
          senderId: message.senderId,
          author: message.author,
          isSelf: message.isSelf || Boolean(selfId && message.senderId === selfId),
          time: message.time,
          lines: [message.text],
        });
      }
    }

    return groups;
  }, [messages, selfId]);

  return (
    <div className="flex h-full min-h-[420px] flex-col">
      <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">Meeting Chat</h3>

      <div
        ref={scrollRef}
        className="mt-4 flex-1 space-y-2 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950/40 p-3"
      >
        {messages.length === 0 ? (
          <p className="text-sm text-slate-400">No messages yet.</p>
        ) : (
          groupedMessages.map((group) => (
            <article
              key={group.key}
              className={`rounded-lg border p-2 ${
                group.isSelf
                  ? "border-teal-500/40 bg-teal-500/10"
                  : "border-slate-700 bg-slate-900/80"
              }`}
            >
              <p className="text-xs font-semibold text-slate-200">
                {group.isSelf ? "You" : group.author}
                <span className="ml-2 text-[11px] font-normal text-slate-400">{group.time}</span>
              </p>
              {group.lines.map((line, index) => (
                <p key={`${group.key}-${index}`} className="mt-1 text-sm text-slate-100">
                  {line}
                </p>
              ))}
            </article>
          ))
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onSend();
            }
          }}
          placeholder="Write a message"
          className="w-full rounded-xl border border-slate-600 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none ring-teal-500 focus:ring"
        />
        <button
          onClick={onSend}
          className="rounded-xl bg-teal-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-700"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function SpeakingBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white shadow-sm shadow-emerald-500/30">
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3 w-3 fill-current">
        <path d="M12 2a3 3 0 0 0-3 3v5a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3Zm-1 13.93V18a1 1 0 0 0 2 0v-2.07A6.002 6.002 0 0 0 18 10h-2a4 4 0 1 1-8 0H6a6.002 6.002 0 0 0 5 5.93Z" />
      </svg>
      Speaking
    </span>
  );
}

function BrandMark() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-950 shadow-lg shadow-slate-950/20">
        <Image src="/icon.png" alt="Conferly logo" width={28} height={28} priority />
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-700">Conferly</p>
        <p className="text-[11px] text-slate-500">Feel the Experience</p>
      </div>
    </div>
  );
}

function UserPhotoPreview({
  photoUrl,
  compact = false,
  fillContainer = false,
}: {
  photoUrl: string;
  compact?: boolean;
  fillContainer?: boolean;
}) {
  const sizeClass = fillContainer
    ? "h-full w-full"
    : compact
      ? "h-44 w-full"
      : "h-[440px] w-full";

  return photoUrl ? (
    <Image
      src={photoUrl}
      alt="User photo"
      width={520}
      height={520}
      unoptimized
      className={`${sizeClass} object-cover`}
    />
  ) : (
    <div
      className={`flex ${sizeClass} items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800`}
    >
      <div className="text-center text-slate-100">
        <Image src="/icon.png" alt="Conferly logo" width={58} height={58} priority />
        <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-300">
          Mic Only
        </p>
      </div>
    </div>
  );
}

function useSpeaking(stream: MediaStream | null, onSpeakingChange?: (speaking: boolean) => void) {
  const [speaking, setSpeaking] = useState(false);
  const onSpeakingChangeRef = useRef(onSpeakingChange);

  useEffect(() => {
    onSpeakingChangeRef.current = onSpeakingChange;
  }, [onSpeakingChange]);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      onSpeakingChangeRef.current?.(false);
      return;
    }

    const AudioContextConstructor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextConstructor) {
      onSpeakingChangeRef.current?.(false);
      return;
    }

    const audioContext = new AudioContextConstructor();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let rafId = 0;
    let activityScore = 0;
    let lastSpeakingState = false;

    const sample = () => {
      analyser.getByteFrequencyData(data);
      let total = 0;
      for (const value of data) {
        total += value;
      }

      const average = total / data.length;
      if (average > 18) {
        activityScore = Math.min(activityScore + 1, 6);
      } else {
        activityScore = Math.max(activityScore - 1, 0);
      }

      const nextSpeaking = activityScore >= 2;
      if (nextSpeaking !== lastSpeakingState) {
        lastSpeakingState = nextSpeaking;
        setSpeaking(nextSpeaking);
        onSpeakingChangeRef.current?.(nextSpeaking);
      }

      rafId = window.requestAnimationFrame(sample);
    };

    void audioContext.resume().then(() => {
      sample();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      source.disconnect();
      analyser.disconnect();
      void audioContext.close();
      onSpeakingChangeRef.current?.(false);
      setSpeaking(false);
    };
  }, [stream]);

  return stream ? speaking : false;
}

function useMeetingTimer(startedAt: number | null) {
  const [elapsed, setElapsed] = useState("00:00");

  useEffect(() => {
    if (!startedAt) {
      return;
    }

    const id = window.setInterval(() => {
      const diffSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const minutes = Math.floor(diffSeconds / 60)
        .toString()
        .padStart(2, "0");
      const seconds = (diffSeconds % 60).toString().padStart(2, "0");
      setElapsed(`${minutes}:${seconds}`);
    }, 1000);

    return () => {
      window.clearInterval(id);
    };
  }, [startedAt]);

  return startedAt ? elapsed : "00:00";
}
