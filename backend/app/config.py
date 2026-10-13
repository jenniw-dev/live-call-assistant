"""Application configuration via environment variables."""

from pathlib import Path

from pydantic_settings import BaseSettings

# Resolve project root: backend/app/config.py → ../../ = project root
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


class Settings(BaseSettings):
    """All config loaded from .env file or environment variables."""

    # --- LLM ---
    llm_base_url: str = "https://api.deepseek.com"
    llm_model: str = "deepseek-v4-flash"
    llm_api_key: str = ""
    # 全局上限；实际按问题分级动态取 256(简单八股)/512(普通技术)/1024(项目深挖)
    llm_max_tokens: int = 1200
    # 低温度：同一问题的建议回答保持一致，不发散
    llm_temperature: float = 0.3
    llm_timeout: int = 10
    # 思考模型（如 qwen3.7-max）关闭 thinking 可把延迟从 15s+ 降到 ~3s
    llm_enable_thinking: bool = False

    # --- 高频问题答案缓存 ---
    answer_cache_enabled: bool = True
    # 问题 Embedding 相似度超过此阈值 → 直接返回历史优质答案
    answer_cache_similarity: float = 0.90

    # --- 缓存预热（延迟优化）---
    # 服务启动后在后台把 KB 高频题的答案预生成写入 answer_cache，
    # 通话时这些常见问题直接命中缓存（~0ms），不再走 LLM
    prewarm_enabled: bool = False
    prewarm_count: int = 30          # 预热题目数量
    prewarm_concurrency: int = 3     # 并发调用 LLM 数

    # --- Knowledge Base ---
    kb_dir: str = ""

    # --- Embedding ---
    embedding_model: str = "BAAI/bge-small-en-v1.5"
    embedding_dimension: int = 384

    # --- RAG Thresholds ---
    # Calibrated with scripts/eval_retrieval.py on bge-small-en-v1.5: every
    # top-1 result >= 0.80 was correct; the highest wrong top-1 was 0.73.
    similarity_hit_threshold: float = 0.80
    # 0.60 → 0.55：让略低分但知识库有对口内容的问题也能注入上下文（知识库利用优化）
    similarity_partial_threshold: float = 0.60
    faiss_top_k: int = 3

    # --- FAISS ---
    faiss_index_path: str = ""

    # --- ASR (语音转写) ---
    # 本地 faster-whisper 模型：tiny/base/small/medium/large-v3 或本地模型目录路径
    asr_model: str = "small"
    # Recognition language: fixed to English for the demo (customer calls); empty = auto-detect
    asr_language: str = "en"
    # 可选：DashScope API Key（配置后本地识别失败时回退到云端 SenseVoice）
    dashscope_api_key: str = ""

    # --- 音频监听（只允许系统音频，禁止麦克风） ---
    # system = WASAPI Loopback / Stereo Mix / BlackHole 等回环源；microphone 恒为 false
    audio_source: str = "system"
    audio_microphone: bool = False

    # --- Audio Enhancement Layer（音频增强，ASR 前处理） ---
    # 高通滤波 + 频谱减法降噪 + 动态 AGC，纯 numpy 实现；
    # 解决客户声音小、通话杂音、不同会议软件音量不一致问题
    audio_enhance_enabled: bool = True
    # 频谱减法过减因子（越大降噪越狠，过大伤语音；1.2~2.0 推荐）
    enhance_subtract_factor: float = 1.6
    # 谱下限（音乐噪声抑制，0.02~0.1）
    enhance_spectral_floor: float = 0.06
    # AGC 目标 RMS（与 audio.py 全局归一化 TARGET_RMS 对齐）
    enhance_target_rms: float = 0.15

    # --- VAD（语音活动检测） ---
    # 内部 Silero VAD（faster-whisper vad_filter）阈值；前端能量 VAD 见 AudioRecorder 常量
    vad_threshold: float = 0.30
    vad_min_speech_ms: int = 250

    # --- Streaming ASR（实时流式识别） ---
    # 总开关：false 时 /api/audio/stream 拒绝连接（旧 HTTP 分段端点不受影响）
    streaming_asr_enabled: bool = True
    # 引擎选择：auto=有 DASHSCOPE_API_KEY 走 Paraformer 真流式，否则本地短分片；
    #           dashscope=强制云端；local=强制本地短分片（降级模式）
    streaming_engine: str = "local"
    # DashScope 双工流式 ASR（Paraformer-realtime，中英混合）
    dashscope_ws_url: str = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
    dashscope_asr_model: str = "paraformer-realtime-v2"
    # 云端 WebSocket 连接+任务建立超时（秒）。注意该超时包含 DNS 解析耗时，
    # 热点/多网卡环境下冷解析可能 3~10s，过紧会把可用的云端连接误判死刑
    dashscope_open_timeout: int = 15
    # 云端引擎启动重试次数（DNS 冷解析间歇性挂起时，单次尝试极易误失败）
    stream_boot_retries: int = 3
    # 云端 WebSocket 中断重连（需求第十二条：自动重连 + 短时音频缓冲）
    stream_reconnect_max: int = 3
    stream_reconnect_buffer_ms: int = 10000   # 重连期间最多缓冲音频时长
    # 本地短分片引擎参数（默认/降级方案）
    stream_local_chunk_ms: int = 1200         # 每累积 1.2s 人声触发一次分片转写
    stream_local_tail_ms: int = 700           # 讲话停顿超过该时长且有累积 → 提前转写尾片
    stream_local_commit_stall_ms: int = 2500  # 无新文本超过该时长 → 未定稿句固化为 final
    # 流式 VAD（仅状态展示，不截断音频流）
    stream_vad_speech: float = 0.50           # 语音概率 > 该值判为人声帧
    stream_vad_silence: float = 0.35          # 语音概率 < 该值判为静音帧
    stream_vad_end_ms: int = 300              # 连续静音达到该时长 → 状态切回"监听"
    # 语音结束后累计静音达到该时长 → 下发 question_ready 信号（仅 UI 提示
    # "问题已完整、可发送"，绝不触发任何自动提交）
    stream_question_ready_ms: int = 1500

    # --- 后端系统音频采集（WASAPI Loopback，仅 Windows 桌面端） ---
    # true 时前端可发 {type:"start", source:"backend"} 由后端直接采集系统
    # 播放声音（通话中客户的声音）；false 或采集失败 → 前端降级 getDisplayMedia
    backend_capture_enabled: bool = False
    backend_capture_samplerate: int = 16000   # 目标采样率（ASR 固定 16kHz）
    backend_capture_blocksize: int = 512      # 32ms @ 16kHz，与流式帧长一致
    backend_capture_device: str = ""          # 按名称子串选播放设备（空=系统默认）
    # 驱动拒绝 16kHz 共享模式请求时 → 按设备原生采样率采集 + 本地抽取降采样
    backend_capture_native_fallback: bool = True

    # --- Endpoint Detection（智能端点检测） ---
    # 语句结束确认静音时长（前端 END_CANDIDATE 触发线），观察窗从 800ms 开始
    endpoint_min_silence_ms: int = 1500
    # 最大静音（超过必然结束语句）
    endpoint_max_silence_ms: int = 3000
    # 自适应延迟开关：按问题长度动态调整等待续说时长
    endpoint_adaptive_delay: bool = True

    # --- 语义完整性判断 ---
    semantic_enabled: bool = True

    # --- 回答触发模式 ---
    # false（默认）：手动模式 —— ASR 文本只写入输入框，用户点"发送"才调用 AI 回答；
    # true：恢复旧版自动模式 —— 端点检测放行后自动提交 LLM。
    # 后端端点决策逻辑两种模式下保持一致，开关只影响前端是否自动提交。
    auto_answer: bool = False

    # --- 问题会话（Question Session） ---
    session_max_question_s: int = 120     # 单个问题会话最长时长
    session_max_question_chars: int = 500  # 合并文本超过此长度强制放行（防连续讲话无限累积）
    session_merge_context: bool = True    # 停顿切开的多段自动合并为一个问题
    session_ttl_s: int = 300              # 空闲会话回收时间
    session_hold_short_ms: int = 1000     # 短问题(<10字) hold 时长
    session_hold_normal_ms: int = 1500    # 普通问题(10~50字)
    session_hold_long_ms: int = 2500      # 长问题(>50字)

    # --- Server ---
    backend_host: str = "127.0.0.1"
    backend_port: int = 8001
    frontend_url: str = "http://localhost:5173"

    @property
    def kb_path(self) -> Path:
        return Path(self.kb_dir)

    @property
    def index_path(self) -> Path:
        if self.faiss_index_path:
            return Path(self.faiss_index_path)
        return _PROJECT_ROOT / "data" / "faiss_index"

    model_config = {
        "env_file": str(_PROJECT_ROOT / ".env"),
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()
