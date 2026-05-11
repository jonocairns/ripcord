const features = [
  {
    title: 'Crystal-clear voice',
    description:
      'Low-latency voice channels powered by mediasoup WebRTC SFU. Mute, deafen, and voice activity detection built in.',
  },
  {
    title: 'Screen share',
    description:
      'Share your screen or a single window. Full control over codec, resolution, and audio passthrough.',
  },
  {
    title: 'Rich text channels',
    description:
      'Message history, emoji, file uploads, and a full rich-text editor — everything you expect from a modern chat app.',
  },
  {
    title: 'Roles & permissions',
    description:
      'Fine-grained per-channel permissions and server roles so you stay in control of who can do what.',
  },
  {
    title: 'Deploy anywhere',
    description:
      'Docker image included. Runs on any Linux box. SQLite database — no external services required.',
  },
  {
    title: 'Plugin system',
    description:
      'Extend Ripcord with plugins and custom commands. Tailor the experience to your community.',
  },
];

export default function Features() {
  return (
    <section className="px-6 py-24 max-w-6xl mx-auto">
      <h2 className="text-3xl font-bold text-center mb-16">
        Everything you need, nothing you don't
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
        {features.map((f) => (
          <div
            key={f.title}
            className="bg-gray-900 rounded-xl p-6 flex flex-col gap-3 border border-gray-800"
          >
            <h3 className="text-lg font-semibold">{f.title}</h3>
            <p className="text-gray-400 text-sm leading-relaxed">{f.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
