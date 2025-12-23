import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders Simple Notes header", () => {
  render(<App />);
  expect(screen.getByText(/Simple Notes/i)).toBeInTheDocument();
});
