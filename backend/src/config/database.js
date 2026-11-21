import mongoose from "mongoose";

const connectDB = async () => {
    try {

        const dbName = process.env.DB_NAME || "Nova_Search";
        const conn = await mongoose.connect(process.env.MONGO_URI, {
            dbName
        });
        console.log(`MongoDB connected: ${conn.connection.host} | Database: ${conn.connection.name}`);
    } catch (error) {
        console.log("Something went wrong in Mongo DB : \n", error);
    }
};

export default connectDB;