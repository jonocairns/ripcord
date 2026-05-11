import Hero from './components/Hero';
import Features from './components/Features';
import GettingStarted from './components/GettingStarted';
import Footer from './components/Footer';

export default function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <Hero />
      <Features />
      <GettingStarted />
      <Footer />
    </div>
  );
}
