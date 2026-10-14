import app from "./app.js";

const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, () => {
  console.log(`Usage Metering Service running on port ${PORT}`);
});
