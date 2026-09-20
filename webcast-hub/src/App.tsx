import { BrowserRouter, Routes, Route } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Receiver from "./pages/Receiver";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/receiver" element={<Receiver />} />
        <Route path="/receiver/:roomId" element={<Receiver />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
